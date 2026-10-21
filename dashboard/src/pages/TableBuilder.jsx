import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { compute, priceFor } from './Calculator';
import dayjs from 'dayjs';
import { getSalesData, getFinancePnl, getSewing, saveSewing, getBuilderTemplates, saveBuilderTemplates, getCalcBase, getPriceRules, savePriceRules, savePricePlans } from '../api';
import { useTableCtl, ThCtl, ResetCtl } from '../components/TableTools';
import { fmtInt, fmtPct } from './AdsStats2';

// ─────────────────────────────────────────────────────────────────────────
// «Конструктор таблицы» (низ «Аналитики продаж»). Строки — артикулы,
// категории, подкатегории или марки; столбцы собираются из набора метрик,
// у каждого свой период («за 4 недели», «за 2 дня»), сдвиг назад и, при
// желании, изменение к предыдущему такому же периоду. Период считается
// назад от конца периода страницы. Фильтры страницы (категория, марка,
// поиск) действуют и здесь; у каждого столбца — сортировка и фильтр «от–до».
// Настройка и шаблоны хранятся в браузере.
// ─────────────────────────────────────────────────────────────────────────

const SEP = ' / ';
// «В пути (отшивается)» — только для чехлов на сиденья.
const SEAT = 'Чехлы / Чехлы на сиденья';
const isSeat = a => a.cat === SEAT || a.cat.startsWith(SEAT + SEP);
const OZ = ['commission', 'logistics', 'acquiring', 'storage', 'promo', 'other'];

// kind: int — штуки, rub — рубли, pct — проценты, num — дробное.
// fin — нужны начисления Ozon (финансы), noDays — период не нужен (на дату).
const METRICS = [
  { g: 'Заказы и трафик', k: 'orders', t: 'Заказы, шт', kind: 'int' },
  { g: 'Заказы и трафик', k: 'revenue', t: 'Заказы, ₽', kind: 'rub' },
  { g: 'Заказы и трафик', k: 'perDay', t: 'Заказов в день', kind: 'num' },
  { g: 'Заказы и трафик', k: 'avgCheck', t: 'Средняя цена заказа', kind: 'rub', d30: true },
  { g: 'Заказы и трафик', k: 'views', t: 'Показы', kind: 'int' },
  { g: 'Заказы и трафик', k: 'pdp', t: 'Переходы в карточку', kind: 'int' },
  { g: 'Заказы и трафик', k: 'cart', t: 'В корзину', kind: 'int' },
  { g: 'Заказы и трафик', k: 'crOrder', t: 'Конверсия в заказ', kind: 'pct' },
  { g: 'Заказы и трафик', k: 'position', t: 'Средняя позиция', kind: 'num' },
  { g: 'Цена', k: 'price', t: 'Цена реализации', kind: 'rub', noDays: true, now: true, price: true },
  { g: 'Цена', k: 'clientPrice', t: 'Цена клиента', kind: 'rub', noDays: true, now: true, price: true },
  { g: 'Цена', k: 'spp', t: 'Скидка Ozon (СПП)', kind: 'pct', noDays: true, now: true, price: true },
  { g: 'Реклама', k: 'spend', t: 'Расход на рекламу', kind: 'rub' },
  { g: 'Реклама', k: 'drr', t: 'ДРР', kind: 'pct' },
  { g: 'Реклама', k: 'adOrders', t: 'Заказы с рекламы', kind: 'int' },
  { g: 'Остатки', k: 'stock', t: 'Остаток', kind: 'int', noDays: true },
  { g: 'Остатки', k: 'cover', t: 'Запаса хватит, дней', kind: 'int' },
  { g: 'Остатки', k: 'sewing', t: 'В пути (отшивается)', kind: 'int', noDays: true, now: true },
  { g: 'Финансы (начисления Ozon)', k: 'buyQty', t: 'Выкупы, шт', kind: 'int', fin: true },
  { g: 'Финансы (начисления Ozon)', k: 'buyRub', t: 'Выкупы, ₽', kind: 'rub', fin: true },
  { g: 'Финансы (начисления Ozon)', k: 'buyCheck', t: 'Средняя цена выкупа', kind: 'rub', fin: true, d30: true },
  { g: 'Финансы (начисления Ozon)', k: 'payout', t: 'Поступление на счёт', kind: 'rub', fin: true },
  { g: 'Финансы (начисления Ozon)', k: 'payUnit', t: 'Поступление на 1 выкуп', kind: 'rub', fin: true },
  { g: 'Финансы (начисления Ozon)', k: 'cost', t: 'Себестоимость выкупов', kind: 'rub', fin: true },
  { g: 'Финансы (начисления Ozon)', k: 'profit', t: 'Чистая прибыль', kind: 'rub', fin: true },
  { g: 'Финансы (начисления Ozon)', k: 'profitUnit', t: 'Прибыль на 1 выкуп', kind: 'rub', fin: true },
  { g: 'Финансы (начисления Ozon)', k: 'margin', t: 'Маржинальность факт', kind: 'pct', fin: true },
  { g: 'Финансы (начисления Ozon)', k: 'roi', t: 'ROI', kind: 'pct', fin: true },
  { g: 'Прогноз (с заказов)', k: 'profitF', t: 'Прибыль прогнозируемая', kind: 'rub' },
  { g: 'Прогноз (с заказов)', k: 'marginF', t: 'Маржинальность прогнозируемая', kind: 'pct' },
];
// Суммируемые метрики — для них есть «в среднем за день / неделю / месяц / год».
const ADDITIVE = new Set(['orders', 'revenue', 'views', 'pdp', 'cart', 'spend', 'adOrders', 'buyQty', 'buyRub', 'payout', 'cost', 'profit', 'profitF']);
const AVG = [['', 'всего за период'], ['d', 'в среднем за день'], ['w', 'в среднем за неделю'], ['m', 'в среднем за месяц'], ['y', 'в среднем за год']];
const AVG_DAYS = { d: 1, w: 7, m: 30.4, y: 365 };
const AVG_T = { d: 'в день', w: 'в неделю', m: 'в месяц', y: 'в год' };
const MET = Object.fromEntries(METRICS.map(m => [m.k, m]));
const GROUPS = [...new Set(METRICS.map(m => m.g))];

const ROW_MODES = [['art', 'Артикулы'], ['cat', 'Категории'], ['sub', 'Подкатегории'], ['brand', 'Марки авто']];

const DEFAULT = {
  rows: 'art',
  cols: [
    { id: 'c1', m: 'orders', days: 28, unit: 'w', off: 0, cmp: false },
    { id: 'c2', m: 'orders', days: 56, unit: 'w', off: 0, cmp: false },
    { id: 'c3', m: 'stock', days: 1, unit: 'd', off: 0, cmp: false },
    { id: 'c4', m: 'margin', days: 28, unit: 'w', off: 0, cmp: false },
    { id: 'c5', m: 'profit', days: 28, unit: 'w', off: 0, cmp: false },
  ],
};
const MAX_SPAN = 400;

const load = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };

const perTxt = (days, unit) => (unit === 'w' && days % 7 === 0 ? `${days / 7} нед` : `${days} дн`);
const colTitle = c => {
  const m = MET[c.m]; if (!m) return '?';
  let t = c.avg && ADDITIVE.has(c.m) ? `Ср. ${m.t.replace(/^./, x => x.toLowerCase())} ${AVG_T[c.avg]}` : m.t;
  if (!m.noDays) t += ` · ${perTxt(c.days, c.unit)}`;
  if (c.off && !m.now) t += ` · ${perTxt(c.off, c.unit)} назад`;
  else if (m.noDays) t += ' · сейчас';
  return t;
};
const fmtVal = (v, kind) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (kind === 'pct') return fmtPct(v);
  if (kind === 'num') return v.toFixed(Math.abs(v) < 10 ? 1 : 0).replace('.', ',');
  if (kind === 'rub') return `${fmtInt(v)} ₽`;
  return fmtInt(v);
};

// Метрика из сумм окна.
function derive(k, S, D) {
  const div = (a, b) => (b ? a / b : null);
  switch (k) {
    case 'perDay': return D ? S.orders / D : null;
    case 'avgCheck': return div(S.revenue, S.orders);
    case 'buyCheck': return div(S.buyRub, S.buyQty);
    case 'crOrder': { const r = div(S.orders, S.pdp); return r === null ? null : r * 100; }
    case 'drr': { const r = div(S.spend, S.revenue); return r === null ? null : r * 100; }
    case 'position': return div(S.posSum, S.posCnt);
    case 'cover': { const pd = D ? S.orders / D : 0; return pd > 0 ? S.stock / pd : (S.stock > 0 ? null : 0); }
    case 'payUnit': return div(S.payout, S.buyQty);
    case 'price': return div(S.priceSum, S.priceCnt);
    case 'clientPrice': return div(S.clientSum, S.clientCnt);
    case 'spp': { const p = div(S.priceSum2, S.priceCnt2), c = div(S.clientSum2, S.priceCnt2); return p && c !== null ? (1 - c / p) * 100 : null; }
    case 'profitUnit': return div(S.profit, S.buyQty);
    case 'margin': { const r = div(S.profit, S.buyRub); return r === null ? null : r * 100; }
    case 'roi': { const r = div(S.profit, S.cost); return r === null ? null : r * 100; }
    case 'profitF': return S.fAny ? S.fProfit : null;
    case 'marginF': { const r = div(S.fProfit, S.fRev); return S.fAny && r !== null ? r * 100 : null; }
    default: return S[k] ?? null;
  }
}
const BASE_KEYS = ['orders', 'revenue', 'views', 'pdp', 'cart', 'spend', 'adOrders', 'posSum', 'posCnt', 'stock', 'sewing', 'buyQty', 'buyRub', 'payout', 'cost', 'profit',
  'priceSum', 'priceCnt', 'clientSum', 'clientCnt', 'priceSum2', 'clientSum2', 'priceCnt2', 'fProfit', 'fRev', 'fAny'];

let idSeq = Date.now();
const newId = () => 'c' + (idSeq++).toString(36);

export default function TableBuilder({ cabinet, anchor, scope, prepare, tax, shareOf, shareAt, forecast, coefOf, onOpenArticle, page, setPage }) {
  const storeKey = `mp-builder:${cabinet}`;
  const [cfg, setCfg] = useState(() => { const s = load(storeKey); return s?.cols?.length ? { rows: s.rows || 'art', cols: s.cols } : DEFAULT; });
  const [templates, setTemplates] = useState(() => load(storeKey + ':tpl') || {});
  const [edit, setEdit] = useState(null); // id столбца в редакторе
  const [full, setFull] = useState(false); // свёрнуто — первые 10 строк
  const [hideEmpty, setHideEmpty] = useState(() => load(storeKey + ':empty') !== false);
  useEffect(() => { save(storeKey + ':empty', hideEmpty); }, [storeKey, hideEmpty]);
  // Своя категория конструктора (хлебные крошки): «Все / Чехлы / Чехлы на сиденья».
  const [catPath, setCatPath] = useState(() => load(storeKey + ':cat') || '');
  useEffect(() => { save(storeKey + ':cat', catPath); }, [storeKey, catPath]);
  const [drag, setDrag] = useState(null); // id перетаскиваемого столбца
  // Набор для выгрузки: артикулы, отмеченные в таблице, — внизу, с новой ценой.
  const [setList, setSetList] = useState(() => load(storeKey + ':set') || []);
  useEffect(() => { save(storeKey + ':set', setList); }, [storeKey, setList]);
  const inSet = useMemo(() => new Set(setList), [setList]);
  const toggleSet = o => setSetList(l => (l.includes(o) ? l.filter(x => x !== o) : [...l, o]));
  const addSet = os => setSetList(l => { const h = new Set(l); return [...l, ...os.filter(o => !h.has(o))]; });
  const removeSet = os => { const h = new Set(os); setSetList(l => l.filter(o => !h.has(o))); };
  // Свои столбцы у набора (сначала — копия столбцов таблицы).
  const [setCols, setSetColsRaw] = useState(() => load(storeKey + ':setcols') || null);
  const setColsEff = setCols || cfg.cols;
  const setSetCols = f => setSetColsRaw(cur => f(cur || cfg.cols).map(c => ({ ...c })));
  useEffect(() => { if (setCols) save(storeKey + ':setcols', setCols); }, [storeKey, setCols]);
  const [over, setOver] = useState(null);
  // Отшивается: артикул → шт (загружается файлом, хранится на сервере).
  const [sew, setSew] = useState({ items: {}, updatedAt: null });
  const [sewMsg, setSewMsg] = useState(null);
  useEffect(() => { getSewing(cabinet).then(r => setSew(r.data.data || { items: {} })).catch(() => {}); }, [cabinet]);
  const sewLc = useMemo(() => { const m = new Map(); for (const [o, q] of Object.entries(sew.items || {})) m.set(o.toLowerCase(), q); return m; }, [sew]);
  const [data, setData] = useState(null);
  const [fin, setFin] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { save(storeKey, cfg); }, [storeKey, cfg]);

  // Сколько дней истории нужно под все столбцы.
  const allCols = useMemo(() => (setList.length ? [...cfg.cols, ...setColsEff] : cfg.cols), [cfg.cols, setColsEff, setList.length]);
  const span = useMemo(() => Math.min(MAX_SPAN, Math.max(30, ...allCols.map(c => (MET[c.m]?.noDays ? 1 : c.days) * (c.cmp ? 2 : 1) + (c.off || 0)))), [allCols]);
  const needFin = allCols.some(c => MET[c.m]?.fin);
  const from = dayjs(anchor).subtract(span - 1, 'day').format('YYYY-MM-DD');

  useEffect(() => {
    let off = false;
    setLoading(true); setErr('');
    getSalesData(cabinet, { dateFrom: from, dateTo: anchor })
      .then(r => { if (!off) setData(r.data.data); })
      .catch(e => { if (!off) setErr(e.response?.data?.error || e.message); })
      .finally(() => { if (!off) setLoading(false); });
    return () => { off = true; };
  }, [cabinet, from, anchor]);
  useEffect(() => {
    if (!needFin) return undefined;
    let off = false;
    getFinancePnl(cabinet, { dateFrom: from, dateTo: anchor }).then(r => { if (!off) setFin(r.data.data); }).catch(() => { if (!off) setFin(null); });
    return () => { off = true; };
  }, [cabinet, from, anchor, needFin]);

  // Цены — текущие (как в «Ценах и марже» и калькуляторе): цена в кабинете и
  // цена для покупателя (с Ozon-картой с сайта, иначе цена × (1 − СПП)).
  const needPrice = allCols.some(c => MET[c.m]?.price) || setList.length > 0;
  const [prices, setPrices] = useState(null);
  useEffect(() => {
    if (!needPrice) return undefined;
    let off = false;
    getCalcBase(cabinet).then(r => {
      if (off) return;
      const d = r.data.data, m = new Map();
      for (const x of d.a || []) {
        const o = d.articles[x[0]]?.o; if (!o || !x[1]) continue;
        const client = x[34] || (x[11] !== null && x[11] !== undefined ? x[1] * (1 - x[11] / 100) : null);
        m.set(o, { price: x[1], client });
      }
      setPrices(m);
    }).catch(() => {});
    return () => { off = true; };
  }, [cabinet, needPrice]);
  const arts = useMemo(() => (data ? prepare(data) : []), [data, prepare]);
  const L = data?.dates.length || 0;

  // Финансы по артикулу и дню (в датах данных продаж).
  const finArt = useMemo(() => {
    if (!fin || !data) return null;
    const di = new Map(data.dates.map((d, i) => [d, i]));
    const pd = fin.dates.map(d => di.get(d));
    const m = new Map();
    const get = o => { let x = m.get(o); if (!x) { x = { s: new Float64Array(L), q: new Float64Array(L), oz: new Float64Array(L), ad: new Float64Array(L), cost: null }; m.set(o, x); } return x; };
    const saleDay = new Float64Array(L), adDay = new Float64Array(L), nsOther = new Float64Array(L), nsAds = new Float64Array(L);
    fin.articles.forEach((a, i) => { if (fin.cost?.[i]) get(a.o).cost = fin.cost[i]; });
    for (const [pai, d0, b, a, q] of fin.rows) {
      const o = fin.articles[pai]?.o, d = pd[d0]; if (!o || d === undefined) continue;
      const k = fin.buckets[b], x = get(o);
      if (k === 'sale' || k === 'return') { x.s[d] += a; saleDay[d] += a; x.q[d] += k === 'sale' ? Math.abs(q) : -Math.abs(q); }
      else if (OZ.includes(k) || k === 'ads') x.oz[d] += a;
    }
    for (const [pai, d0, v] of fin.ads || []) { const o = fin.articles[pai]?.o, d = pd[d0]; if (!o || d === undefined) continue; get(o).ad[d] += v; adDay[d] += v; }
    let lastFin = -1;
    for (const [d0, b, a] of fin.noSku || []) {
      const d = pd[d0]; if (d === undefined) continue;
      const k = fin.buckets[b];
      if (k === 'ads') { nsAds[d] += a; if (a) lastFin = Math.max(lastFin, d); } else if (OZ.includes(k)) nsOther[d] += a;
    }
    const ai = fin.buckets.indexOf('ads');
    for (const r of fin.rows) if (r[2] === ai && r[3] && pd[r[1]] !== undefined) lastFin = Math.max(lastFin, pd[r[1]]);
    return { m, saleDay, adDay, nsOther, nsAds, lastFin, mn: fin.available?.mn || null };
  }, [fin, data, L]);

  // Суммы окна по артикулу: window = [lo, hi] индексов.
  const sumsOf = useCallback((a, lo, hi, D) => {
    const S = Object.fromEntries(BASE_KEYS.map(k => [k, 0]));
    if (hi < 0) return S;
    const l = Math.max(0, lo);
    for (let d = l; d <= hi; d++) {
      S.orders += a.orders[d]; S.revenue += a.revenue[d]; S.views += a.views[d]; S.pdp += a.pdpViews[d]; S.cart += a.cart[d];
      S.spend += a.spendCpc[d] + a.spendCpo[d]; S.adOrders += a.adOrders[d];
      if (a.pos[d] !== null) { S.posSum += a.pos[d]; S.posCnt++; }
      // Прогноз с заказов дня — как «Прогнозируемая прибыль» страницы (юнит-экономика артикула).
      if (forecast && (a.orders[d] > 0 || a.spendCpc[d] + a.spendCpo[d] > 0)) {
        const r = forecast(a.o, data.dates[d], a.revenue[d], a.orders[d], a.spendCpc[d] + a.spendCpo[d]);
        if (r) { S.fProfit += r.profit; S.fRev += r.expRev; S.fAny = 1; }
      }
    }
    S.stock = a.stockArr[hi] ?? 0;
    S.sewing = isSeat(a) ? (sewLc.get(String(a.o).toLowerCase()) || 0) : 0;
    const pr = prices?.get(a.o);
    if (pr) {
      S.priceSum = pr.price; S.priceCnt = 1;
      if (pr.client) { S.clientSum = pr.client; S.clientCnt = 1; S.priceSum2 = pr.price; S.clientSum2 = pr.client; S.priceCnt2 = 1; }
    }
    const x = finArt?.m.get(a.o);
    if (finArt && x) {
      let s = 0, q = 0, oz = 0, ad = 0, saleW = 0, adW = 0, nsA = 0;
      for (let d = l; d <= hi; d++) { s += x.s[d]; q += x.q[d]; oz += x.oz[d]; ad += x.ad[d]; saleW += finArt.saleDay[d]; adW += finArt.adDay[d]; nsA += finArt.nsAds[d]; }
      const shareW = saleW ? s / saleW : 0;
      // Прочее без артикула — по выручке дня (как в P&L), реклама без артикула — по расходу кабинета.
      let other = 0;
      for (let d = l; d <= hi; d++) other += finArt.nsOther[d] * (finArt.saleDay[d] > 0 ? x.s[d] / finArt.saleDay[d] : shareW);
      // Дни, которые Ozon ещё не провёл в начислениях: рекламу берём из кабинета.
      let adLate = 0;
      for (let d = Math.max(l, finArt.lastFin + 1); d <= hi; d++) adLate += x.ad[d];
      const pay = s + oz + other + nsA * (adW > 0 ? ad / adW : shareW) - adLate;
      const cost = (x.cost || 0) * Math.max(0, q);
      S.buyQty = q; S.buyRub = s; S.payout = pay; S.cost = cost;
      // Налог — как в «P&L»: от оплаты покупателя по отчётам «Начисления» того дня.
      let base = 0;
      if (shareAt) { for (let d = l; d <= hi; d++) if (x.s[d]) base += x.s[d] * (shareAt(a.o, data.dates[d]) ?? 1); }
      else base = s * (shareOf ? shareOf(a.o) : 1);
      S.profit = pay - cost - base * (tax || 0) / 100;
    }
    return S;
  }, [finArt, shareOf, shareAt, forecast, data, tax, sewLc, prices]);

  const inPath = a => !catPath || a.cat === catPath || a.cat.startsWith(catPath + SEP);
  const inScope = useMemo(() => arts.filter(a => (!scope || scope.has(a.o)) && inPath(a)), [arts, scope, catPath]); // eslint-disable-line react-hooks/exhaustive-deps
  // Подкатегории текущей категории (для выпадающего списка и режима «Категории»).
  const depth = catPath ? catPath.split(SEP).length : 0;
  const kidsOf = useMemo(() => {
    const m = new Map();
    for (const a of arts) {
      if ((scope && !scope.has(a.o)) || !inPath(a) || a.parts.length <= depth) continue;
      const k = a.parts.slice(0, depth + 1).join(SEP);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()];
  }, [arts, scope, catPath, depth]); // eslint-disable-line react-hooks/exhaustive-deps

  // Значения: строки → [ { v, prev } по каждому столбцу ].
  const table = useMemo(() => {
    if (!L) return { rows: [], total: null };
    const groupOf = a => (cfg.rows === 'art' ? a.o
      : cfg.rows === 'cat' ? (a.parts.length > depth ? a.parts.slice(0, depth + 1).join(SEP) : catPath)
        : cfg.rows === 'sub' ? a.cat : (a.brand || 'Не определена'));
    const groups = new Map();
    for (const a of inScope) { const g = groupOf(a); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(a); }
    const specOf = cols => cols.map(c => {
      const m = MET[c.m]; const D = m?.noDays ? 1 : c.days;
      const hi = L - 1 - (c.off || 0), lo = hi - D + 1;
      return { c, m, D, lo, hi, plo: lo - D, phi: lo - 1, partial: lo < 0 || (m?.fin && finArt?.mn && data.dates[Math.max(0, lo)] < finArt.mn) };
    });
    const colsSpec = specOf(cfg.cols), setSpec = specOf(setColsEff);
    const calc = (list, spec = colsSpec) => spec.map(({ c, m, D, lo, hi, plo, phi }) => {
      if (!m) return { v: null };
      const add = (lo2, hi2) => {
        const T = Object.fromEntries(BASE_KEYS.map(k => [k, 0]));
        for (const a of list) { const S = sumsOf(a, lo2, hi2, D); for (const k of BASE_KEYS) T[k] += S[k]; }
        return derive(c.m, T, D);
      };
      // «В среднем за …» — сумма окна / дней окна × дней в выбранной единице.
      const k = c.avg && ADDITIVE.has(c.m) ? AVG_DAYS[c.avg] / D : 1;
      const sc = x => (x === null || x === undefined ? x : x * k);
      const v = sc(add(lo, hi));
      const p = c.cmp && !m.noDays ? (plo >= 0 ? sc(add(plo, phi)) : null) : undefined;
      return { v, p };
    });
    const rows = [...groups.entries()].map(([key, list]) => {
      const a = cfg.rows === 'art' ? list[0] : null;
      const name = a ? a.o : (cfg.rows === 'cat' || cfg.rows === 'sub') && catPath && key.startsWith(catPath + SEP) ? key.slice(catPath.length + SEP.length) : key === catPath && cfg.rows === 'cat' ? `${key.split(SEP).pop()} (без подкатегории)` : key;
      return { key, a, list, name, cat: a ? a.cat : '', sub: a ? a.short : `${list.length} арт.`, vals: calc(list) };
    });
    // Набор — по всем артикулам, независимо от фильтров таблицы.
    const byO = new Map(arts.map(a => [a.o, a]));
    const setRows = setList.map(o => byO.get(o)).filter(Boolean).map(a => ({ key: a.o, a, vals: calc([a], setSpec) }));
    return { rows, total: { key: '__t', name: 'Итого', sub: `${inScope.length} арт.`, vals: calc(inScope) }, colsSpec, setRows };
  }, [L, cfg, inScope, sumsOf, finArt, data, depth, catPath, arts, setList, setColsEff]);

  const ctl = useTableCtl(`builder-${cabinet}`);
  // «Пустые» строки — все значения нулевые или пустые (обычно артикулы без движения).
  const rowsIn = useMemo(() => (hideEmpty ? table.rows.filter(r => r.vals.some(x => (x.v && Number.isFinite(x.v)) || (x.p && Number.isFinite(x.p)))) : table.rows), [table.rows, hideEmpty]);
  const shown = useMemo(() => ctl.apply(rowsIn, (r, k) => {
    if (k === '__name') return r.name;
    if (k === '__cat') return r.cat;
    const i = cfg.cols.findIndex(c => c.id === k);
    return i < 0 ? null : r.vals[i]?.v ?? null;
  }), [ctl, rowsIn, cfg.cols]);

  const setCol = (id, patch) => setCfg(s => ({ ...s, cols: s.cols.map(c => (c.id === id ? { ...c, ...patch } : c)) }));
  const moveCol = (id, dir) => setCfg(s => {
    const i = s.cols.findIndex(c => c.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= s.cols.length) return s;
    const cols = [...s.cols]; [cols[i], cols[j]] = [cols[j], cols[i]];
    return { ...s, cols };
  });
  const addCol = () => { const id = newId(); setCfg(s => ({ ...s, cols: [...s.cols, { id, m: 'orders', days: 7, unit: 'd', off: 0, cmp: false }] })); setEdit(id); };
  const delCol = id => { setCfg(s => ({ ...s, cols: s.cols.filter(c => c.id !== id) })); setEdit(null); };
  // Перетаскивание столбца (за плашку сверху или за заголовок таблицы): ставим перед тем, на который бросили.
  const dropCol = (src, dst) => setCfg(s => {
    if (!src || src === dst) return s;
    const cols = s.cols.filter(c => c.id !== src), moved = s.cols.find(c => c.id === src);
    const j = dst ? cols.findIndex(c => c.id === dst) : cols.length;
    const si = s.cols.findIndex(c => c.id === src), di = s.cols.findIndex(c => c.id === dst);
    cols.splice(j < 0 ? cols.length : j + (di > si ? 1 : 0), 0, moved);
    return { ...s, cols };
  });
  const dnd = id => ({
    draggable: true,
    onDragStart: e => { setDrag(id); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', id); } catch (x) { /* ignore */ } },
    onDragOver: e => { if (drag) { e.preventDefault(); setOver(id); } },
    onDragLeave: () => setOver(o => (o === id ? null : o)),
    onDrop: e => { e.preventDefault(); dropCol(drag, id); setDrag(null); setOver(null); },
    onDragEnd: () => { setDrag(null); setOver(null); },
  });
  const openRow = r => {
    if (r.a) return onOpenArticle?.(r.a.o);
    if (cfg.rows === 'cat' || cfg.rows === 'sub') {
      // Провалиться внутрь: дальше — подкатегории, а если их нет — артикулы.
      const hasKids = arts.some(a => a.parts.length > r.key.split(SEP).length && (a.cat.startsWith(r.key + SEP)));
      setCatPath(r.key);
      if (!hasKids || cfg.rows === 'sub') setCfg(s => ({ ...s, rows: 'art' }));
    }
    return null;
  };

  // Загрузка файла «отшивается»: 1-я колонка — артикул, 2-я — количество.
  const seatArts = useMemo(() => arts.filter(isSeat), [arts]);
  async function onSewFile(e) {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    setSewMsg(null);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await f.arrayBuffer());
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
      const byLc = new Map(arts.map(a => [String(a.o).toLowerCase(), a]));
      const items = {}, unknown = [], notSeat = [];
      let bad = 0;
      for (const row of aoa) {
        const o = String(row[0] ?? '').trim(); if (!o) continue;
        const q = Number(String(row[1] ?? '').replace(/\s/g, '').replace(',', '.'));
        if (!Number.isFinite(q)) { bad++; continue; } // шапка или пустое количество
        const a = byLc.get(o.toLowerCase());
        if (!a) { unknown.push(o); continue; }
        if (!isSeat(a)) { notSeat.push(a.o); continue; }
        if (q > 0) items[a.o] = (items[a.o] || 0) + Math.round(q);
      }
      const n = Object.keys(items).length, tot = Object.values(items).reduce((x, y) => x + y, 0);
      const warn = [unknown.length ? `не нашёл артикулы: ${unknown.slice(0, 6).join(', ')}${unknown.length > 6 ? ` и ещё ${unknown.length - 6}` : ''}` : '',
        notSeat.length ? `не чехлы на сиденья (пропущены): ${notSeat.slice(0, 6).join(', ')}${notSeat.length > 6 ? ` и ещё ${notSeat.length - 6}` : ''}` : ''].filter(Boolean).join('; ');
      if (!n && !window.confirm('В файле нет ни одного чехла на сиденья с количеством. Очистить список «отшивается»?')) return;
      if (n && !window.confirm(`Загрузить «отшивается»: ${n} арт., ${tot} шт? Прежний список заменится.${warn ? '\n\n' + warn : ''}`)) return;
      const r = await saveSewing(cabinet, items);
      setSew(r.data.data);
      setSewMsg({ bad: !!warn, text: `Загружено: ${n} арт., ${tot} шт.${warn ? ' ' + warn[0].toUpperCase() + warn.slice(1) + '.' : ''}` });
    } catch (x) { setSewMsg({ bad: true, text: 'Не удалось прочитать файл: ' + x.message }); }
  }
  async function sewTemplate() {
    const XLSX = await import('xlsx');
    const aoa = [['Артикул', 'Отшивается, шт'], ...[...seatArts].sort((x, y) => String(x.o).localeCompare(String(y.o), 'ru', { numeric: true })).map(a => [a.o, sewLc.get(String(a.o).toLowerCase()) || ''])];
    const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = [{ wch: 20 }, { wch: 16 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Отшивается');
    XLSX.writeFile(wb, `Отшивается_${cabinet}_${dayjs().format('YYYY-MM-DD')}.xlsx`);
  }
  const sewTotal = Object.values(sew.items || {}).reduce((x, y) => x + y, 0);
  const hasSewCol = cfg.cols.some(c => c.m === 'sewing');

  // ── Шаблоны ─────────────────────────────────────────────────────────
  // Шаблон — всё, что видно: период и фильтры страницы (категория, марка,
  // поиск), строки и столбцы конструктора, его категория, «скрыть пустые»,
  // сортировка и фильтры столбцов. Период «до сегодня» хранится скользящим
  // («последние N дней»), иначе — конкретными датами. Хранятся на сервере.
  const pageSnap = () => {
    if (!page) return null;
    const rel = page.dateTo === page.today ? dayjs(page.dateTo).diff(dayjs(page.dateFrom), 'day') + 1 : null;
    return { rel, dateFrom: page.dateFrom, dateTo: page.dateTo, sel: page.sel || '', brand: page.brand || '', search: page.search || '' };
  };
  const snap = () => ({ rows: cfg.rows, cols: cfg.cols, catPath, hideEmpty, sort: ctl.sort || null, filters: ctl.filters || {}, page: pageSnap(), savedAt: new Date().toISOString() });
  const [activeTpl, setActiveTpl] = useState(null);
  const [tplOpen, setTplOpen] = useState(false);
  const [renaming, setRenaming] = useState(null); // [старое имя, новое]
  const [newName, setNewName] = useState('');
  const tplRef = React.useRef(null);
  useEffect(() => {
    if (!tplOpen) return undefined;
    const h = e => { if (tplRef.current && !tplRef.current.contains(e.target)) setTplOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [tplOpen]);
  const sig = t => JSON.stringify({ rows: t.rows, cols: t.cols, catPath: t.catPath || '', hideEmpty: !!t.hideEmpty, sort: t.sort || null, filters: t.filters || {},
    page: t.page ? { rel: t.page.rel || null, dateFrom: t.page.rel ? null : t.page.dateFrom, dateTo: t.page.rel ? null : t.page.dateTo, sel: t.page.sel || '', brand: t.page.brand || '', search: t.page.search || '' } : null });
  const tplDirty = activeTpl && templates[activeTpl]
    ? sig({ ...snap(), page: templates[activeTpl].page ? pageSnap() : null }) !== sig(templates[activeTpl])
    : true;
  // Загрузка с сервера; старые шаблоны из браузера переносятся туда.
  const [tplReady, setTplReady] = useState(false);
  useEffect(() => {
    let off = false;
    setTplReady(false);
    getBuilderTemplates(cabinet).then(r => {
      if (off) return;
      const srv = r.data.data?.templates;
      const local = load(storeKey + ':tpl') || {};
      setTemplates(srv ? { ...local, ...srv } : local);
      setTplReady(true);
    }).catch(() => { if (!off) setTplReady(true); });
    return () => { off = true; };
  }, [cabinet]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!tplReady) return;
    saveBuilderTemplates(cabinet, templates).catch(() => {});
  }, [templates, tplReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveTplAs = name => {
    const k = String(name || '').trim(); if (!k) return;
    if (templates[k] && k !== activeTpl && !window.confirm(`Шаблон «${k}» уже есть. Перезаписать его текущей таблицей?`)) return;
    setTemplates(t => ({ ...t, [k]: snap() }));
    setActiveTpl(k); setNewName('');
  };
  // Таблица «до шаблона» — чтобы можно было выйти из шаблона и вернуться к ней.
  const baseRef = React.useRef(null);
  const applyTpl = name => {
    const t = templates[name]; if (!t) return;
    if (!activeTpl) baseRef.current = { cfg, catPath, hideEmpty, sort: ctl.sort || null, filters: ctl.filters || {}, page: page ? { dateFrom: page.dateFrom, dateTo: page.dateTo, sel: page.sel || '', brand: page.brand || '', search: page.search || '' } : null };
    if (t.page && setPage) {
      const p = t.page;
      const dateTo = p.rel ? page.today : p.dateTo;
      const dateFrom = p.rel ? dayjs(page.today).subtract(p.rel - 1, 'day').format('YYYY-MM-DD') : p.dateFrom;
      setPage({ dateFrom, dateTo, sel: p.sel || '', brand: p.brand || '', search: p.search || '' });
    }
    setCfg({ rows: t.rows || 'art', cols: (t.cols || []).map(c => ({ ...c })) });
    setCatPath(t.catPath || '');
    setHideEmpty(t.hideEmpty !== undefined ? !!t.hideEmpty : true);
    ctl.reset();
    if (t.sort) ctl.setSort(t.sort);
    for (const [k, f] of Object.entries(t.filters || {})) ctl.setFilter(k, f);
    setEdit(null);
    setActiveTpl(name);
    setTplOpen(false);
  };
  // Закрыть шаблон: вернуть таблицу и фильтры страницы, какими они были до его открытия.
  const closeTpl = () => {
    const b = baseRef.current;
    if (b) {
      if (b.page && setPage) setPage(b.page);
      setCfg(b.cfg); setCatPath(b.catPath || ''); setHideEmpty(b.hideEmpty);
      ctl.reset();
      if (b.sort) ctl.setSort(b.sort);
      for (const [k, f] of Object.entries(b.filters || {})) ctl.setFilter(k, f);
    }
    baseRef.current = null;
    setActiveTpl(null); setEdit(null);
  };
  const delTpl = name => {
    if (!window.confirm(`Удалить шаблон «${name}»?`)) return;
    setTemplates(t => { const n = { ...t }; delete n[name]; return n; });
    if (activeTpl === name) setActiveTpl(null);
  };
  const renameTpl = (from, to) => {
    const k = String(to || '').trim();
    setRenaming(null);
    if (!k || k === from) return;
    if (templates[k]) { window.alert(`Шаблон «${k}» уже есть — выберите другое название.`); return; }
    // Порядок сохраняем: пересобираем объект с новым ключом на том же месте.
    setTemplates(t => Object.fromEntries(Object.entries(t).map(([n, v]) => [n === from ? k : n, v])));
    if (activeTpl === from) setActiveTpl(k);
  };
  const tplDesc = t => {
    const parts = [ROW_MODES.find(r => r[0] === t.rows)?.[1] || ''];
    if (t.page) {
      parts.push(t.page.rel ? `последние ${t.page.rel} дн` : `${dayjs(t.page.dateFrom).format('DD.MM')}–${dayjs(t.page.dateTo).format('DD.MM.YY')}`);
      if (t.page.sel) parts.push(t.page.sel.split(SEP).pop());
      if (t.page.brand) parts.push(t.page.brand);
      if (t.page.search) parts.push(`«${t.page.search}»`);
    }
    if (t.catPath) parts.push(t.catPath.split(SEP).pop());
    parts.push(`${(t.cols || []).length} столб.`);
    const nf = Object.keys(t.filters || {}).length;
    if (nf) parts.push(`фильтров: ${nf}`);
    return parts.filter(Boolean).join(' · ');
  };
  // Сортировка и фильтры по столбцу, которого больше нет, не должны прятать всю таблицу.
  useEffect(() => {
    const ok = new Set(['__name', '__cat', ...cfg.cols.map(c => c.id)]);
    for (const k of Object.keys(ctl.filters || {})) if (!ok.has(k)) ctl.setFilter(k, null);
    if (ctl.sort && !ok.has(ctl.sort.k)) ctl.setSort(null);
  }, [cfg.cols]); // eslint-disable-line react-hooks/exhaustive-deps

  const csv = () => {
    // Для артикулов: отдельно артикул, модель и категория — чтобы артикул можно было сопоставлять в Excel.
    const isArt = cfg.rows === 'art';
    const lead = r => (isArt ? (r.a ? [r.a.o, r.a.short || '', r.cat || ''] : [r.name, '', '']) : [r.name]);
    const head = [...(isArt ? ['Артикул', 'Модель', 'Категория'] : [ROW_MODES.find(r => r[0] === cfg.rows)[1]]), ...cfg.cols.flatMap(c => (c.cmp && !MET[c.m]?.noDays ? [colTitle(c), colTitle(c) + ' (пред.)'] : [colTitle(c)]))];
    const num = v => (v === null || v === undefined || !Number.isFinite(v) ? '' : String(Math.round(v * 100) / 100).replace('.', ','));
    const lines = [head, ...[table.total, ...shown].map(r => [...lead(r), ...r.vals.flatMap((x, i) => (cfg.cols[i].cmp && !MET[cfg.cols[i].m]?.noDays ? [num(x.v), num(x.p)] : [num(x.v)]))])];
    const text = '﻿' + lines.map(l => l.map(s => `"${String(s).replace(/"/g, '""')}"`).join(';')).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const el = document.createElement('a'); el.href = url; el.download = `таблица-${anchor}.csv`; el.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const ed = cfg.cols.find(c => c.id === edit);
  const LIMIT = 300;

  const cell = (x, i, colsArr = cfg.cols) => {
    const m = MET[colsArr[i]?.m];
    if (!x || !m) return '—';
    const main = fmtVal(x.v, m.kind);
    if (x.p === undefined) return main;
    let delta = null;
    if (x.p !== null && x.v !== null && Number.isFinite(x.v) && Number.isFinite(x.p)) {
      if (m.kind === 'pct') delta = { t: `${x.v - x.p >= 0 ? '+' : '−'}${Math.abs(x.v - x.p).toFixed(1).replace('.', ',')} п.п.`, up: x.v >= x.p };
      else if (x.p !== 0) { const ch = (x.v - x.p) / Math.abs(x.p) * 100; delta = Math.abs(ch) < 0.5 ? { t: '0%', up: true } : { t: `${ch >= 0 ? '+' : '−'}${Math.abs(ch).toFixed(0)}%`, up: ch >= 0 }; }
    }
    return (
      <span title={`Предыдущий период: ${fmtVal(x.p, m.kind)}`}>
        {main}
        {delta && <span className={`tb-d ${delta.up ? 'up' : 'dn'}`}>{delta.t}</span>}
      </span>
    );
  };

  return (
    <div className="a-card tb-card">
      <div className="a-bar" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <b style={{ fontSize: 14 }}>Конструктор таблицы</b>
        <span className="a-hint" style={{ margin: 0 }}>периоды считаются назад от {dayjs(anchor).format('DD.MM.YYYY')} (конец периода страницы)</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {activeTpl && (
            <span className={`tb-active ${tplDirty ? 'dirty' : ''}`} title={tplDirty ? 'Таблицу меняли после открытия шаблона' : 'Открыт шаблон'}>
              Шаблон: <b>{activeTpl}</b>{tplDirty ? ' · изменён' : ''}
              {tplDirty && <button type="button" onClick={() => saveTplAs(activeTpl)} title="Записать текущую таблицу в этот шаблон">сохранить</button>}
              {tplDirty && <button type="button" onClick={() => applyTpl(activeTpl)} title="Вернуть как было в шаблоне">вернуть</button>}
              <button type="button" className="tb-x" onClick={closeTpl} title="Закрыть шаблон — вернуть таблицу и фильтры, какими они были до его открытия">× закрыть</button>
            </span>
          )}
          <span className="tb-tplwrap" ref={tplRef}>
            <button type="button" className={`a-btn ghost ${tplOpen ? 'on' : ''}`} onClick={() => setTplOpen(o => !o)}>Шаблоны{Object.keys(templates).length ? ` (${Object.keys(templates).length})` : ''} ▾</button>
            {tplOpen && (
              <div className="tb-tplpop">
                {!Object.keys(templates).length && <div className="muted" style={{ padding: '6px 4px' }}>Шаблонов пока нет. Настройте период, фильтры и столбцы — и сохраните.</div>}
                {Object.entries(templates).map(([n, t]) => (
                  <div key={n} className={`tb-tplrow ${activeTpl === n ? 'on' : ''}`}>
                    {renaming && renaming[0] === n ? (
                      <input className="a-input" autoFocus value={renaming[1]} onChange={e => setRenaming([n, e.target.value])}
                        onKeyDown={e => { if (e.key === 'Enter') renameTpl(n, renaming[1]); if (e.key === 'Escape') setRenaming(null); }} onBlur={() => renameTpl(n, renaming[1])} />
                    ) : (
                      <button type="button" className="tb-tplname" onClick={() => applyTpl(n)} title="Открыть шаблон">
                        <b>{n}</b><span>{tplDesc(t)}</span>
                      </button>
                    )}
                    <span className="tb-tplact">
                      <button type="button" title="Переименовать" onClick={() => setRenaming([n, n])}>✎</button>
                      <button type="button" title="Записать в этот шаблон текущую таблицу" onClick={() => { if (window.confirm(`Перезаписать «${n}» текущей таблицей?`)) { setTemplates(x => ({ ...x, [n]: snap() })); setActiveTpl(n); } }}>⤓</button>
                      <button type="button" title="Удалить шаблон" onClick={() => delTpl(n)}>×</button>
                    </span>
                  </div>
                ))}
                <form className="tb-tplnew" onSubmit={e => { e.preventDefault(); saveTplAs(newName); }}>
                  <input className="a-input" placeholder="Название нового шаблона" value={newName} onChange={e => setNewName(e.target.value)} />
                  <button type="submit" className="a-btn" disabled={!newName.trim()}>Сохранить текущий</button>
                </form>
                <div className="a-hint" style={{ margin: '6px 2px 0' }}>Шаблон запоминает период и фильтры страницы, строки, столбцы, сортировку и фильтры таблицы. Период «до сегодня» открывается как «последние N дней».</div>
              </div>
            )}
          </span>
          <button type="button" className="a-btn ghost" onClick={csv} title="Скачать таблицу (Excel откроет)">⬇ CSV</button>
        </span>
      </div>

      <div className="tb-bar">
        <span className="tb-lbl">Строки</span>
        <span className="a-seg">
          {ROW_MODES.map(([k, t]) => <button key={k} type="button" className={cfg.rows === k ? 'on' : ''} onClick={() => setCfg(s => ({ ...s, rows: k }))}>{t}</button>)}
        </span>
        <button type="button" className="a-toggle" style={{ marginLeft: 8 }} onClick={() => setHideEmpty(v => !v)} title="Не показывать строки, где во всех столбцах ноль или пусто">
          <span className={`a-sw ${hideEmpty ? 'on' : ''}`} />Скрыть пустые
        </button>
      </div>
      <div className="tb-bar">
        <span className="tb-lbl">Категория</span>
        <span className="tb-crumbs">
          <button type="button" className={!catPath ? 'on' : ''} onClick={() => setCatPath('')}>Все</button>
          {catPath && catPath.split(SEP).map((p, i, arr) => {
            const path = arr.slice(0, i + 1).join(SEP);
            return <React.Fragment key={path}><span className="sep">/</span><button type="button" className={path === catPath ? 'on' : ''} onClick={() => setCatPath(path)}>{p}</button></React.Fragment>;
          })}
        </span>
        {kidsOf.length > 0 && (
          <select className="a-input tb-sel" value="" onChange={e => e.target.value && setCatPath(e.target.value)} title="Выбрать подкатегорию">
            <option value="">{catPath ? 'подкатегория…' : 'выбрать категорию…'}</option>
            {kidsOf.map(([k, n]) => <option key={k} value={k}>{k.split(SEP).pop()} · {n}</option>)}
          </select>
        )}
      </div>
      <ColsEditor cols={cfg.cols} setCols={f => setCfg(s => ({ ...s, cols: f(s.cols) }))} edit={edit} setEdit={setEdit} hdrDrag={drag} hdrOver={over} dnd={dnd} afterChips={null} />

      {hasSewCol && (
        <div className="tb-bar tb-sew">
          <span className="tb-lbl">Отшивается</span>
          <span>{sewTotal ? `${fmtInt(sewTotal)} шт по ${Object.keys(sew.items).length} арт.` : 'пока не загружено'}{sew.updatedAt ? ` · загружено ${dayjs(sew.updatedAt).format('DD.MM.YYYY HH:mm')}` : ''}</span>
          <label className="a-btn ghost" style={{ cursor: 'pointer' }} title="Excel или CSV: 1-я колонка — артикул, 2-я — сколько штук шьётся. Прежний список заменится.">
            Загрузить файл<input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={onSewFile} />
          </label>
          <button type="button" className="a-btn ghost" onClick={sewTemplate} title="Все чехлы на сиденья с текущими количествами">Скачать шаблон</button>
          {sewMsg && <span className={sewMsg.bad ? 'tb-warn' : 'muted'}>{sewMsg.text}</span>}
        </div>
      )}


      {err && !data ? <div className="a-empty" style={{ padding: 18 }}>Не удалось загрузить: {err}</div>
        : !data ? <div className="a-empty" style={{ padding: 18 }}>Загрузка…</div> : (
          <div className="a-scroll" style={{ opacity: loading ? 0.6 : 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="a-hint" style={{ margin: 0 }}>
                {needFin && !fin ? 'Загружаю финансы…' : needFin && finArt?.mn && table.colsSpec?.some(s => s.partial && s.m?.fin) ? `* начисления Ozon есть с ${dayjs(finArt.mn).format('DD.MM.YYYY')} — период столбца захватывает дни без данных` : ''}
              </span>
              <ResetCtl ctl={ctl} />
            </div>
            <table className="a-t s-slice tb-t">
              <thead><tr>
                <ThCtl ctl={ctl} k="__name" className="" filter={false}>{cfg.rows === 'art' && (() => {
                  const os = shown.filter(r => r.a).map(r => r.a.o), all = os.length > 0 && os.every(o => inSet.has(o));
                  return <SetMark on={all} title={all ? `Убрать из набора все ${os.length} арт. по фильтрам` : `Добавить в набор все ${os.length} арт. по фильтрам`}
                    onClick={e => { e.stopPropagation(); if (all) removeSet(os); else addSet(os); }} />;
                })()}{ROW_MODES.find(r => r[0] === cfg.rows)[1]}</ThCtl>
                {cfg.rows === 'art' && <ThCtl ctl={ctl} k="__cat" className="tb-catth" filter={false} hint="Сортировка по категории">Категория</ThCtl>}
                {cfg.cols.map((c, i) => (
                  <ThCtl key={c.id} ctl={ctl} k={c.id} unit={MET[c.m]?.kind === 'pct' ? '%' : MET[c.m]?.kind === 'rub' ? '₽' : ''}
                    className={`r tb-th ${over === c.id && drag && drag !== c.id ? 'over' : ''}`} dnd={dnd(c.id)}>
                    {colTitle(c)}{table.colsSpec?.[i]?.partial ? '*' : ''}
                  </ThCtl>
                ))}
              </tr></thead>
              <tbody>
                {table.total && (
                  <tr className="tb-total">
                    <td><b>Итого</b> <span className="muted" style={{ fontSize: 11.5 }}>{table.total.sub}</span></td>
                    {cfg.rows === 'art' && <td className="muted">{catPath ? catPath.split(SEP).pop() : ''}</td>}
                    {table.total.vals.map((x, i) => <td key={cfg.cols[i].id} className="n r">{cell(x, i)}</td>)}
                  </tr>
                )}
                {!shown.length && <tr><td colSpan={cfg.cols.length + 2} className="muted" style={{ padding: 12 }}>Ничего не подходит под фильтр</td></tr>}
                {shown.slice(0, full ? LIMIT : 10).map(r => (
                  <tr key={r.key} className="row" onClick={() => openRow(r)} title={r.a ? 'Открыть артикул в дереве выше' : cfg.rows !== 'brand' ? 'Показать, что внутри' : ''}>
                    <td><div className="a-art">{r.a && <SetMark on={inSet.has(r.a.o)} onClick={e => { e.stopPropagation(); toggleSet(r.a.o); }} />}<div style={{ minWidth: 0 }}><div className="id">{r.name}{!r.a && cfg.rows !== 'brand' ? ' ›' : ''}</div><div className="model" title={r.a?.n || ''}>{r.sub}</div></div></div></td>
                    {cfg.rows === 'art' && <td className="muted tb-cat" title={r.cat}>{(catPath && r.cat.startsWith(catPath + SEP) ? r.cat.slice(catPath.length + SEP.length) : r.cat.split(SEP).slice(-2).join(SEP)) || '—'}</td>}
                    {r.vals.map((x, i) => <td key={cfg.cols[i].id} className="n r">{cell(x, i)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length > 10 && <button type="button" className="s-fold" onClick={() => setFull(f => !f)}>{full ? 'Свернуть ▲' : `Показать все ${Math.min(shown.length, LIMIT)}${shown.length > LIMIT ? ` из ${shown.length}` : ''} ▼`}</button>}
            {full && shown.length > LIMIT && <div className="a-hint">Показаны первые {LIMIT} из {shown.length} — уточните фильтр или скачайте CSV.</div>}
          </div>
        )}
      <PriceSet cabinet={cabinet} storeKey={storeKey} rows={table.setRows || []} cols={setColsEff} setCols={setSetCols} cell={(x, i) => cell(x, i, setColsEff)} prices={prices} coefOf={coefOf} tax={tax} data={data}
        onRemove={toggleSet} onClear={() => setSetList([])} setCount={setList.length} />
    </div>
  );
}

// Столбцы таблицы: плашки (нажать — изменить, перетащить — поменять местами) и редактор столбца.
// Общий для конструктора и для набора для выгрузки.
function ColsEditor({ cols, setCols, edit, setEdit, dnd, hdrDrag: drag, hdrOver: over }) {
  const ed = cols.find(c => c.id === edit);
  const setCol = (id, patch) => setCols(cs => cs.map(c => (c.id === id ? { ...c, ...patch } : c)));
  const moveCol = (id, dir) => setCols(cs => {
    const i = cs.findIndex(c => c.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= cs.length) return cs;
    const n = [...cs]; [n[i], n[j]] = [n[j], n[i]]; return n;
  });
  const addCol = () => { const id = newId(); setCols(cs => [...cs, { id, m: 'orders', days: 7, unit: 'd', off: 0, cmp: false }]); setEdit(id); };
  const delCol = id => { setCols(cs => cs.filter(c => c.id !== id)); setEdit(null); };
  return (
    <>
      <div className="tb-bar">
        <span className="tb-lbl">Столбцы</span>
        {cols.map(c => (
          <button key={c.id} type="button" {...dnd(c.id)} title="Нажмите — изменить; перетащите — поменять местами"
            className={`tb-chip ${edit === c.id ? 'on' : ''} ${drag === c.id ? 'drag' : ''} ${over === c.id && drag && drag !== c.id ? 'over' : ''}`} onClick={() => setEdit(e => (e === c.id ? null : c.id))}>
            {colTitle(c)}{c.cmp && !MET[c.m]?.noDays ? ' · Δ' : ''}
          </button>
        ))}
        <button type="button" className="tb-chip add" onClick={addCol}>+ столбец</button>
      </div>
      {ed && (
        <div className="tb-ed">
          <label>Метрика
            <select className="a-input" value={ed.m} onChange={e => { const m = e.target.value; setCol(ed.id, MET[m]?.d30 ? { m, days: 30, unit: 'd', off: 0 } : { m }); }}>
              {GROUPS.map(g => <optgroup key={g} label={g}>{METRICS.filter(m => m.g === g).map(m => <option key={m.k} value={m.k}>{m.t}</option>)}</optgroup>)}
            </select>
          </label>
          {!MET[ed.m]?.noDays && (
            <label>За
              <span className="tb-pair">
                <input className="a-input" type="number" min="1" value={ed.unit === 'w' ? ed.days / 7 : ed.days}
                  onChange={e => { const n = Math.max(1, Math.round(Number(e.target.value) || 1)); setCol(ed.id, { days: Math.min(MAX_SPAN, ed.unit === 'w' ? n * 7 : n) }); }} />
                <select className="a-input" value={ed.unit} onChange={e => { const u = e.target.value; setCol(ed.id, { unit: u, days: u === 'w' ? Math.max(7, Math.round(ed.days / 7) * 7) : ed.days, off: u === 'w' ? Math.round((ed.off || 0) / 7) * 7 : ed.off }); }}>
                  <option value="d">дней</option><option value="w">недель</option>
                </select>
              </span>
            </label>
          )}
          {!MET[ed.m]?.now && <label title="На сколько отступить назад от конца периода страницы. 0 — период заканчивается сегодня (концом периода); 4 нед — те же 4 недели, но месяц назад.">{MET[ed.m]?.noDays ? 'На дату' : 'Сдвиг назад'}
            <span className="tb-pair">
              <input className="a-input" type="number" min="0" value={ed.unit === 'w' ? (ed.off || 0) / 7 : ed.off || 0}
                onChange={e => { const n = Math.max(0, Math.round(Number(e.target.value) || 0)); setCol(ed.id, { off: Math.min(MAX_SPAN - 1, ed.unit === 'w' ? n * 7 : n) }); }} />
              <span className="tb-u">{ed.unit === 'w' ? 'нед' : 'дн'} {MET[ed.m]?.noDays ? 'назад' : ''}</span>
            </span>
          </label>}
          {ADDITIVE.has(ed.m) && (
            <label title="Например, «Заказы, шт» за 12 недель «в среднем за год» = заказы за 12 недель / 84 дня × 365">Показать
              <select className="a-input" value={ed.avg || ''} onChange={e => setCol(ed.id, { avg: e.target.value })}>
                {AVG.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
              </select>
            </label>
          )}
          {ed.m === 'sewing' && <span className="a-hint" style={{ margin: 0, maxWidth: 360 }}>Только чехлы на сиденья. Количество загружается файлом — строка «Отшивается» под столбцами.</span>}
          {!MET[ed.m]?.noDays && (
            <label className="tb-chk"><input type="checkbox" checked={!!ed.cmp} onChange={e => setCol(ed.id, { cmp: e.target.checked })} />изменение к предыдущим {perTxt(ed.days, ed.unit)}</label>
          )}
          <span className="tb-act">
            <button type="button" className="a-btn ghost" onClick={() => moveCol(ed.id, -1)} title="Левее">←</button>
            <button type="button" className="a-btn ghost" onClick={() => moveCol(ed.id, 1)} title="Правее">→</button>
            <button type="button" className="a-btn ghost" onClick={() => delCol(ed.id)}>удалить</button>
            <button type="button" className="a-btn" onClick={() => setEdit(null)}>готово</button>
          </span>
        </div>
      )}
    </>
  );
}

// Значок «в наборе»: контур с плюсом; в наборе — залит цветом с галочкой.
function SetMark({ on, onClick, title }) {
  return (
    <button type="button" className={`tb-mark ${on ? 'on' : ''}`} onClick={onClick}
      title={title || (on ? 'В наборе для выгрузки (внизу) — нажмите, чтобы убрать' : 'Добавить в набор для выгрузки (внизу)')}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">{on
        ? <path d="M4 8.2l2.6 2.6L12 5.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        : <path d="M8 4v8M4 8h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}</svg>
    </button>
  );
}

function PriceInput({ value, placeholder, onCommit }) {
  const [v, setV] = useState(value ?? '');
  const focus = useRef(false);
  useEffect(() => { if (!focus.current) setV(value ?? ''); }, [value]);
  return (
    <input className={`a-input tb-price ${value ? 'ed' : ''}`} inputMode="decimal" value={v} placeholder={placeholder}
      onFocus={() => { focus.current = true; }} onBlur={() => { focus.current = false; onCommit(v); }}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      onChange={e => setV(e.target.value.replace(',', '.').replace(/[^\d.]/g, ''))} />
  );
}

// Правило (группа) новой цены: вписать своё или выбрать из запомненных.
function RuleInput({ value, auto, disabled, listId, onCommit }) {
  const [v, setV] = useState(value ?? '');
  const focus = useRef(false);
  useEffect(() => { if (!focus.current) setV(value ?? ''); }, [value]);
  return (
    <input className={`a-input tb-rule ${value ? (auto ? 'auto' : 'own') : ''}`} list={listId} value={v} disabled={disabled}
      placeholder={disabled ? '' : 'правило'} title={disabled ? 'Сначала впишите новую цену' : auto ? 'Правило проставлено автоматически — можно переписать' : 'Своё правило'}
      onFocus={() => { focus.current = true; }} onBlur={() => { focus.current = false; if (v.trim() !== (value || '')) onCommit(v.trim()); }}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setV(value ?? ''); e.currentTarget.blur(); } }}
      onChange={e => setV(e.target.value.slice(0, 60))} />
  );
}
const num1 = v => String(Math.round(v * 10) / 10).replace('.', ',');
const BULK_RULE = { 'rub-': v => `−${fmtInt(v)} ₽`, 'rub+': v => `+${fmtInt(v)} ₽`, 'pct-': v => `−${num1(v)}%`, 'pct+': v => `+${num1(v)}%`, margin: v => `маржа ${num1(v)}%`, set: v => `цена ${fmtInt(v)} ₽` };

// Набор для выгрузки: артикул, метрики верхней таблицы, текущая и новая цена и
// прогноз при новой цене — как в калькуляторе (юнит-экономика артикула, ДРР — свой
// за последние 30 дней: реклама / (заказы × % выкупа)). Скачивается в Excel с выбором столбцов.
function PriceSet({ cabinet, storeKey, rows, cols, setCols, cell, prices, coefOf, tax, data, onRemove, onClear, setCount }) {
  const [edit, setEdit] = useState(null);
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  const dropCol = (src, dst) => setCols(cs => {
    if (!src || src === dst) return cs;
    const n = cs.filter(c => c.id !== src), moved = cs.find(c => c.id === src);
    const si = cs.findIndex(c => c.id === src), di = cs.findIndex(c => c.id === dst);
    const j = n.findIndex(c => c.id === dst);
    n.splice(j < 0 ? n.length : j + (di > si ? 1 : 0), 0, moved);
    return n;
  });
  const dnd = id => ({
    draggable: true,
    onDragStart: e => { setDrag(id); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', id); } catch (x) { /* ignore */ } },
    onDragOver: e => { if (drag) { e.preventDefault(); setOver(id); } },
    onDragLeave: () => setOver(o => (o === id ? null : o)),
    onDrop: e => { e.preventDefault(); dropCol(drag, id); setDrag(null); setOver(null); },
    onDragEnd: () => { setDrag(null); setOver(null); },
  });
  const ctl = useTableCtl(storeKey.replace('mp-builder:', 'builder-set-'));
  const [fullS, setFullS] = useState(false);
  const [mode, setMode] = useState(() => load(storeKey + ':setmode') || 'client');
  useEffect(() => { save(storeKey + ':setmode', mode); }, [storeKey, mode]);
  const [np, setNp] = useState(() => load(storeKey + ':setprices') || {}); // артикул -> { v, m, r (правило), ra (проставлено автоматически) }
  // Запомненные правила (группы) — общие для кабинета, хранятся на сервере.
  const [ruleList, setRuleList] = useState([]);
  useEffect(() => { getPriceRules(cabinet).then(r => setRuleList(r.data.data || [])).catch(() => {}); }, [cabinet]);
  const rememberRule = name => { if (name && !ruleList.includes(name)) savePriceRules(cabinet, [name]).then(r => setRuleList(r.data.data || [])).catch(() => {}); };
  const forgetRule = name => savePriceRules(cabinet, [], [name]).then(r => setRuleList(r.data.data || [])).catch(() => {});
  useEffect(() => { save(storeKey + ':setprices', np); }, [storeKey, np]);
  const [pick, setPick] = useState(false);
  const [exp, setExp] = useState(() => { const e = load(storeKey + ':setexp') || { art: true, newPrice: true }; return e.rule === undefined ? { ...e, rule: true } : e; });
  useEffect(() => { save(storeKey + ':setexp', exp); }, [storeKey, exp]);
  const pickRef = useRef(null);
  useEffect(() => {
    if (!pick) return undefined;
    const on = e => { if (pickRef.current && !pickRef.current.contains(e.target)) setPick(false); };
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [pick]);

  const L = data?.dates.length || 0;
  const model = useMemo(() => rows.map(r => {
    const a = r.a, k = coefOf ? coefOf(a.o) : null, pr = prices?.get(a.o);
    const cur = pr?.price || k?.price || null;
    // Доля цены клиента от цены реализации: по ценам на сайте, иначе по модели артикула.
    // (цена клиента выше цены реализации — устаревшие данные сайта: тогда по модели)
    const sppK = pr?.client && pr?.price && pr.client <= pr.price ? pr.client / pr.price : k ? 1 - (k.spp || 0) / 100 : 1;
    const curClient = pr?.client && pr.client <= (cur || Infinity) ? pr.client : (cur ? cur * sppK : null);
    // ДРР — свой за последние 30 дней данных: реклама / (заказы × выкуп).
    let sp = 0, rv = 0;
    for (let d = Math.max(0, L - 30); d < L; d++) { sp += a.spendCpc[d] + a.spendCpo[d]; rv += a.revenue[d]; }
    const v = k ? {
      spp: (1 - sppK) * 100, cost: k.cost || 0, buyout: k.buyout * 100, defect: 0, commission: k.comm * 100, acquiring: k.acq * 100,
      direct: k.direct ?? k.logi, ret: k.direct !== null && k.direct !== undefined ? k.ret : 0, other: k.other * 100, oper: 0, tax: tax || 0,
      drr: rv > 0 && k.buyout > 0 ? sp / (rv * k.buyout) * 100 : 0,
    } : null;
    const o = np[a.o];
    const newReal = o && o.v > 0 ? (o.m === 'client' ? o.v / (sppK || 1) : o.v) : null;
    const at = newReal || cur;
    const res = v && at ? compute(v, at, 'usn_income') : null;
    return { ...r, k, v, cur, curClient, sppK, newReal, res, o };
  }), [rows, coefOf, prices, tax, np, L]);

  const sorted = useMemo(() => ctl.apply(model, (x, k) => {
    if (k === '__name') return x.a.o;
    if (k === '__cur') return x.cur;
    if (k === '__client') return x.curClient;
    if (k === '__new') return x.newReal;
    if (k === '__rule') return x.o?.r || null;
    if (k === '__profit') return x.res ? x.res.profit : null;
    if (k === '__margin') return x.res ? x.res.margin : null;
    const i = cols.findIndex(c => c.id === k); return i >= 0 ? x.vals[i]?.v ?? null : null;
  }), [model, ctl, cols]); // eslint-disable-line react-hooks/exhaustive-deps
  // Фильтр «изменённые»: все / с новой ценой / без неё.
  const [chg, setChg] = useState('');
  const sortedF = useMemo(() => (chg === 'ed' ? sorted.filter(x => x.newReal) : chg === 'no' ? sorted.filter(x => !x.newReal) : sorted), [sorted, chg]);
  const total = model.length, totalEd = model.filter(x => x.newReal).length, shownEd = sortedF.filter(x => x.newReal).length;
  // Массовое изменение цены у показанных строк (по текущим фильтрам набора).
  const [bulk, setBulk] = useState({ kind: 'rub-', val: '', skip: true });
  const bulkNum = () => Number(String(bulk.val).replace(',', '.'));
  const bulkPrice = x => {
    const v = bulkNum();
    if (!(v > 0) && bulk.kind !== 'margin') return null;
    const base = mode === 'client' ? x.curClient : x.cur;
    let p = null;
    if (bulk.kind === 'rub-') p = base - v; else if (bulk.kind === 'rub+') p = base + v;
    else if (bulk.kind === 'pct-') p = base * (1 - v / 100); else if (bulk.kind === 'pct+') p = base * (1 + v / 100);
    else if (bulk.kind === 'set') p = v;
    else if (bulk.kind === 'margin') { if (!x.v || !Number.isFinite(v)) return null; const r = priceFor(x.v, 'usn_income', v); p = r ? (mode === 'client' ? r * x.sppK : r) : null; }
    return p && p > 0 && Number.isFinite(p) ? Math.round(p) : null;
  };
  // «Назначить правило» — только название группы, цены не трогает (у показанных с новой ценой).
  const ruleOnly = bulk.kind === 'rule';
  const bulkTargets = ruleOnly ? sortedF.filter(x => x.newReal) : sortedF.filter(x => !(bulk.skip && x.newReal));
  const applyBulk = () => {
    if (ruleOnly) {
      const name = String(bulk.val).trim(); if (!name) return;
      const h = new Set(bulkTargets.map(x => x.a.o));
      setNp(m => Object.fromEntries(Object.entries(m).map(([o, e]) => [o, h.has(o) ? { ...e, r: name, ra: false } : e])));
      rememberRule(name);
      setBulkMsg(`Правило «${name}» — у ${h.size} арт.`);
      return;
    }
    let n = 0, miss = 0;
    const upd = {}, rule = BULK_RULE[bulk.kind](bulkNum());
    for (const x of bulkTargets) { const p = bulkPrice(x); if (p) { upd[x.a.o] = { v: p, m: mode, r: rule, ra: true }; n++; } else miss++; }
    setNp(m => ({ ...m, ...upd }));
    setBulkMsg(`Изменено ${n} арт. · правило «${rule}»${miss ? `, не посчитать — ${miss} (нет текущей цены или маржа недостижима)` : ''}`);
  };
  const [bulkMsg, setBulkMsg] = useState('');
  const resetShown = () => { const h = new Set(sortedF.map(x => x.a.o)); setNp(m => Object.fromEntries(Object.entries(m).filter(([o]) => !h.has(o)))); };
  const shownNew = x => (!x.o ? '' : x.o.m === mode ? x.o.v : Math.round(mode === 'client' ? x.o.v * x.sppK : x.o.v / (x.sppK || 1)));
  // Ручная цена: автоматическое правило становится «вручную», своё — остаётся.
  const setPrice = (o, val) => setNp(m => {
    const n = { ...m }, e = m[o];
    if (!(Number(val) > 0)) { delete n[o]; return n; }
    if (e && e.m === mode && e.v === Number(val)) return m;
    n[o] = { v: Number(val), m: mode, ...(e?.r && !e.ra ? { r: e.r, ra: false } : { r: 'вручную', ra: true }) };
    return n;
  });
  const setRule = (o, name) => { setNp(m => (m[o] ? { ...m, [o]: { ...m[o], r: name || 'вручную', ra: !name } } : m)); if (name) rememberRule(name); };
  const rulesUsed = useMemo(() => [...new Set([...Object.values(np).map(e => e.r).filter(Boolean), ...ruleList])], [np, ruleList]);
  const listId = `tb-rules-${cabinet}`;
  const newOut = x => (x.newReal ? Math.round(mode === 'client' ? x.newReal * x.sppK : x.newReal) : Math.round(mode === 'client' ? x.curClient : x.cur) || null);

  const EXP = [
    ['art', 'Артикул', x => x.a.o], ['model', 'Название', x => x.a.n || ''], ['cat', 'Категория', x => x.a.cat],
    ['cur', 'Цена реализации сейчас', x => x.cur && Math.round(x.cur)], ['curClient', 'Цена клиента сейчас', x => x.curClient && Math.round(x.curClient)],
    ['newPrice', `Новая цена (${mode === 'client' ? 'клиента' : 'реализации'})`, newOut],
    ['rule', 'Правило', x => (x.newReal ? x.o?.r || '' : '')],
    ['profit', 'Прибыль на 1 шт при новой цене (прогноз)', x => x.res && Math.round(x.res.profit)],
    ['margin', 'Маржинальность при новой цене (прогноз), %', x => x.res && Math.round(x.res.margin * 10) / 10],
    ...cols.map((c, i) => [c.id, colTitle(c), x => { const y = x.vals[i]?.v; return y === null || y === undefined || !Number.isFinite(y) ? '' : Math.round(y * 10) / 10; }]),
  ];
  async function download() {
    const XLSX = await import('xlsx');
    const use = EXP.filter(([k]) => exp[k]);
    const aoa = [use.map(([, t]) => t), ...sortedF.map(x => use.map(([, , f]) => f(x) ?? ''))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Набор');
    XLSX.writeFile(wb, `Набор ${dayjs().format('DD.MM.YYYY')}.xlsx`);
    // Запомнить, какие цены и по какому правилу выгрузили, — журнал цен узнает группы,
    // даже если цены потом перенесут в общий файл без колонки «Правило».
    const items = sortedF.filter(x => x.newReal && x.o?.r).map(x => ({ o: x.a.o, c: Math.round(x.newReal * x.sppK), r: Math.round(x.newReal), rule: x.o.r }));
    if (items.length) savePricePlans(cabinet, items).then(() => getPriceRules(cabinet)).then(r => setRuleList(r.data.data || [])).catch(() => {});
  }

  return (
    <div className="tb-set">
      <div className="a-bar" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <b style={{ fontSize: 14 }}>Набор для выгрузки</b>
        <span className="a-hint" style={{ margin: 0 }}>{setCount
          ? <>показано <b>{sortedF.length}</b> из {total} арт. · с новой ценой <b className="tb-edn">{shownEd} / {total}</b>{shownEd !== totalEd ? ` (всего ${totalEd})` : ''}</>
          : 'нажмите ＋ у артикула в таблице выше — он появится здесь (в таблице останется отмеченным)'}</span>
        {setCount > 0 && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="tb-lbl" style={{ width: 'auto' }}>новая цена —</span>
            <span className="a-seg">
              <button type="button" className={mode === 'client' ? 'on' : ''} onClick={() => setMode('client')}>цена клиента</button>
              <button type="button" className={mode === 'real' ? 'on' : ''} onClick={() => setMode('real')}>цена реализации</button>
            </span>
            <span className="tb-tplwrap" ref={pickRef}>
              <button type="button" className="a-btn" onClick={() => setPick(o => !o)}>⬇ Excel ▾</button>
              {pick && (
                <div className="tb-tplpop" style={{ minWidth: 300 }}>
                  <div className="muted" style={{ padding: '2px 4px 6px' }}>Какие столбцы выгрузить</div>
                  {EXP.map(([k, t]) => (
                    <label key={k} className="tb-chk" style={{ display: 'flex', padding: '3px 4px' }}>
                      <input type="checkbox" checked={!!exp[k]} onChange={e => setExp(x => ({ ...x, [k]: e.target.checked }))} />{t}
                    </label>
                  ))}
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button type="button" className="a-btn ghost" onClick={() => setExp({ art: true, newPrice: true })}>артикул + цена</button>
                    <button type="button" className="a-btn" onClick={() => { download(); setPick(false); }}>Скачать показанные ({sortedF.length})</button>
                  </div>
                  <div className="a-hint" style={{ margin: '6px 2px 0' }}>Где новая цена не вписана — в файл уходит текущая.</div>
                </div>
              )}
            </span>
            <button type="button" className="a-btn ghost" onClick={() => { if (window.confirm('Очистить набор?')) { onClear(); setNp({}); } }}>очистить</button>
          </span>
        )}
      </div>
      {setCount > 0 && <ColsEditor cols={cols} setCols={setCols} edit={edit} setEdit={setEdit} dnd={dnd} hdrDrag={drag} hdrOver={over} />}
      {setCount > 0 && (
        <div className="tb-bar tb-bulk">
          <span className="tb-lbl">Изменить</span>
          <select className="a-input" value={bulk.kind} onChange={e => setBulk(b => ({ ...b, kind: e.target.value }))}>
            <option value="rub-">снизить на ₽</option><option value="rub+">поднять на ₽</option>
            <option value="pct-">снизить на %</option><option value="pct+">поднять на %</option>
            <option value="margin">цена под маржинальность, %</option><option value="set">поставить цену, ₽</option>
            <option value="rule">назначить правило (без смены цены)</option>
          </select>
          {ruleOnly
            ? <input className="a-input" style={{ width: 180 }} list={listId} value={bulk.val} placeholder="название группы" onChange={e => setBulk(b => ({ ...b, val: e.target.value.slice(0, 60) }))} />
            : <input className="a-input" style={{ width: 80 }} inputMode="decimal" value={bulk.val} placeholder={bulk.kind === 'margin' ? '15' : bulk.kind.startsWith('pct') ? '3' : '500'}
                onChange={e => setBulk(b => ({ ...b, val: e.target.value.replace(/[^\d.,-]/g, '') }))} />}
          {!ruleOnly && <label className="tb-chk"><input type="checkbox" checked={bulk.skip} onChange={e => setBulk(b => ({ ...b, skip: e.target.checked }))} />не трогать уже изменённые</label>}
          <button type="button" className="a-btn" disabled={!bulk.val || !bulkTargets.length} onClick={applyBulk}
            title={ruleOnly ? 'Название группы для показанных артикулов с новой ценой' : `От текущей ${mode === 'client' ? 'цены клиента' : 'цены реализации'}; маржинальность — как в калькуляторе. Ко всем строкам набора по текущим фильтрам${bulk.skip ? ', кроме уже изменённых' : ''}. Правило проставится само`}>Применить к {bulkTargets.length} арт.</button>
          <button type="button" className="a-btn ghost" disabled={!shownEd} onClick={() => { if (window.confirm(`Сбросить новые цены у ${shownEd} показанных арт.?`)) resetShown(); }}>сбросить у показанных</button>
          {bulkMsg && <span className="muted">{bulkMsg}</span>}
          <span className="a-seg" style={{ marginLeft: 'auto' }}>
            {[['', 'все'], ['ed', `с новой ценой (${totalEd})`], ['no', `без неё (${total - totalEd})`]].map(([k, t]) => <button key={k} type="button" className={chg === k ? 'on' : ''} onClick={() => setChg(k)}>{t}</button>)}
          </span>
          <ResetCtl ctl={ctl} />
        </div>
      )}
      {setCount > 0 && (
        <div className="a-scroll">
          <table className="a-t s-slice tb-t">
            <thead><tr>
              <ThCtl ctl={ctl} k="__name" className="" filter={false}>Артикул</ThCtl>
              <ThCtl ctl={ctl} k="__cur" unit="₽">Цена реализации</ThCtl><ThCtl ctl={ctl} k="__client" unit="₽">Цена клиента</ThCtl>
              <ThCtl ctl={ctl} k="__new" unit="₽" hint="Впишите новую цену — пересчитается прогноз строки">Новая цена ({mode === 'client' ? 'клиента' : 'реализации'})</ThCtl>
              <ThCtl ctl={ctl} k="__rule" className="" filter={false} hint="Группа изменения: проставляется массовым изменением, можно переписать или выбрать из запомненных. Уходит в Excel и в журнал цен">Правило</ThCtl>
              <ThCtl ctl={ctl} k="__profit" unit="₽" hint="Как в калькуляторе: юнит-экономика артикула при новой цене (без новой — при текущей), ДРР — свой за 30 дней">Прибыль на 1 шт, прогноз</ThCtl>
              <ThCtl ctl={ctl} k="__margin" unit="%" hint="Прибыль / цена реализации при новой цене — как в калькуляторе">Маржинальность, прогноз</ThCtl>
              {cols.map(c => (
                <ThCtl key={c.id} ctl={ctl} k={c.id} unit={MET[c.m]?.kind === 'pct' ? '%' : MET[c.m]?.kind === 'rub' ? '₽' : ''}
                  className={`r tb-th ${over === c.id && drag && drag !== c.id ? 'over' : ''}`} dnd={dnd(c.id)}>{colTitle(c)}</ThCtl>
              ))}
              <th />
            </tr></thead>
            <tbody>
              {(fullS ? sortedF : sortedF.slice(0, 30)).map(x => (
                <tr key={x.key} className={x.newReal ? 'tb-ed-row' : ''}>
                  <td><div className="a-art"><span className={`tb-dot ${x.newReal ? 'on' : ''}`} title={x.newReal ? 'Новая цена внесена' : 'Без изменений'} /><div style={{ minWidth: 0 }}><div className="id">{x.a.o}</div><div className="model" title={x.a.n || ''}>{x.a.short}</div></div></div></td>
                  <td className="n r">{x.cur ? fmtInt(x.cur) : '—'}</td>
                  <td className="n r">{x.curClient ? fmtInt(x.curClient) : '—'}</td>
                  <td className="r"><PriceInput value={shownNew(x)} placeholder={fmtInt(mode === 'client' ? x.curClient : x.cur)} onCommit={val => setPrice(x.a.o, val)} /></td>
                  <td><RuleInput value={x.newReal ? x.o?.r || '' : ''} auto={x.o?.ra} disabled={!x.newReal} listId={listId} onCommit={v => setRule(x.a.o, v)} /></td>
                  <td className="n r" style={{ color: x.res && x.res.profit < 0 ? 'var(--a-bad)' : undefined }}>{x.res ? `${fmtInt(x.res.profit)} ₽` : '—'}</td>
                  <td className="n r"><b style={{ color: x.res && x.res.margin < 0 ? 'var(--a-bad)' : undefined }}>{x.res ? fmtPct(x.res.margin) : '—'}</b>{x.newReal && x.cur && x.v ? <small className="tb-was">было {fmtPct(compute(x.v, x.cur, 'usn_income').margin)}</small> : null}</td>
                  {x.vals.map((y, i) => <td key={cols[i].id} className="n r">{cell(y, i)}</td>)}
                  <td className="r"><button type="button" className="tb-x" title="Убрать из набора" onClick={() => onRemove(x.a.o)}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {sortedF.length > 30 && <button type="button" className="s-fold" onClick={() => setFullS(f => !f)}>{fullS ? 'Свернуть ▲' : `Показать все ${sortedF.length} ▼`}</button>}
          <datalist id={listId}>{rulesUsed.map(r => <option key={r} value={r} />)}</datalist>
          {ruleList.length > 0 && (
            <div className="tb-rules">
              <span className="muted">Запомненные правила:</span>
              {ruleList.slice(0, 30).map(r => <span key={r} className="tb-rchip">{r}<button type="button" title="Забыть" onClick={() => forgetRule(r)}>×</button></span>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
