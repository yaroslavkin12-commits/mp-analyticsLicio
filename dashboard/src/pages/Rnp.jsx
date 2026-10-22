import React, { useState, useEffect, useMemo, useRef } from 'react';
import dayjs from 'dayjs';
import { getAdsGroups, getAdsTransit, getPriceDynamics } from '../api';
import { fmtInt, fmtPct } from './AdsStats2';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «РНП» (рука на пульсе): по каждой группе — блок метрик столбиком, по
// горизонтали дни (свежие слева), «Итого», прошлый период и динамика.
// Группировка — по категориям или по группам «Рекламы»; любую строку можно
// раскрыть до артикулов. Ячейки подсвечены внутри строки: лучше — зеленее.
// Прибыль факт — как в «P&L» (начисления Ozon по дню, реклама за не
// проведённые дни — из кабинета, себестоимость, налог по «Начислениям»);
// при наведении — раскладка.
// ─────────────────────────────────────────────────────────────────────────

const SEP = ' / ';
const OZ = ['commission', 'logistics', 'acquiring', 'storage', 'promo', 'other'];
const OZ_T = { commission: 'Комиссия', logistics: 'Логистика', acquiring: 'Эквайринг', storage: 'Хранение', promo: 'Продвижение и акции', other: 'Прочие услуги' };
// Суммы по дню (складываются по артикулам и по дням).
const KEYS = ['views', 'pdp', 'cart', 'orders', 'revenue', 'spend', 'spendCpc', 'spendCpo', 'adOrders', 'clicks', 'stock', 'stockN',
  'buyQty', 'buyRub', ...OZ.map(k => 'oz_' + k), 'ozAds', 'nsOther', 'nsAds', 'adLate', 'cost', 'tax', 'profit', 'finAny',
  'fProfit', 'fRev', 'fAny', 'bW', 'bN', 'pW', 'cW', 'wN', 'pS', 'cS', 'pN'];
const LAST = new Set(['stock', 'stockN']); // остаток — на конец периода, а не сумма

const d0 = (a, b) => (b ? a / b : null);
const pc = (a, b) => (b ? (a / b) * 100 : null);
// dir: 1 — больше лучше, -1 — меньше лучше, 0 — без подсветки.
const METRICS = [
  { g: 'Воронка', k: 'views', t: 'Показы', kind: 'int', dir: 1, v: S => S.views },
  { g: 'Воронка', k: 'pdp', t: 'Переходы в карточку', kind: 'int', dir: 1, v: S => S.pdp },
  { g: 'Воронка', k: 'ctr', t: 'CTR (показ → карточка), %', kind: 'pct', dir: 1, v: S => pc(S.pdp, S.views) },
  { g: 'Воронка', k: 'cart', t: 'В корзину, шт', kind: 'int', dir: 1, v: S => S.cart },
  { g: 'Воронка', k: 'crCart', t: 'Конверсия в корзину, %', kind: 'pct', dir: 1, v: S => pc(S.cart, S.pdp) },
  { g: 'Воронка', k: 'crOrder', t: 'Конверсия в заказ, %', kind: 'pct', dir: 1, v: S => pc(S.orders, S.pdp) },
  { g: 'Заказы', k: 'orders', t: 'Заказы, шт', kind: 'int', dir: 1, v: S => S.orders, strong: true },
  { g: 'Заказы', k: 'revenue', t: 'Заказы, ₽', kind: 'rub', dir: 1, v: S => S.revenue, strong: true },
  { g: 'Заказы', k: 'avgCheck', t: 'Средний чек, ₽', kind: 'rub', dir: 0, v: S => d0(S.revenue, S.orders) },
  { g: 'Цена', k: 'price', t: 'Цена до СПП, ₽', kind: 'rub', dir: 0, v: S => (S.wN ? S.pW / S.wN : d0(S.pS, S.pN)) },
  { g: 'Цена', k: 'client', t: 'Цена после СПП, ₽', kind: 'rub', dir: 0, v: S => (S.wN ? S.cW / S.wN : d0(S.cS, S.pN)) },
  { g: 'Цена', k: 'spp', t: 'СПП, %', kind: 'pct', dir: 0, v: S => { const p = S.wN ? S.pW / S.wN : d0(S.pS, S.pN), c = S.wN ? S.cW / S.wN : d0(S.cS, S.pN); return p && c ? (1 - c / p) * 100 : null; } },
  { g: 'Реклама', k: 'spend', t: 'Расход на рекламу, ₽', kind: 'rub', dir: 0, v: S => S.spend },
  { g: 'Реклама', k: 'drr', t: 'ДРР от заказов, %', kind: 'pct', dir: -1, v: S => pc(S.spend, S.revenue) },
  { g: 'Реклама', k: 'adOrders', t: 'Заказы с рекламы, шт', kind: 'int', dir: 1, v: S => S.adOrders },
  { g: 'Реклама', k: 'adShare', t: 'Доля заказов с рекламы, %', kind: 'pct', dir: 0, v: S => pc(S.adOrders, S.orders) },
  { g: 'Остатки', k: 'stock', t: 'Остаток, шт', kind: 'int', dir: 0, v: S => (S.stockN ? S.stock : null) },
  { g: 'Остатки', k: 'transit', t: 'В пути, шт', kind: 'int', dir: 0, now: true, v: () => null },
  { g: 'Остатки', k: 'cover', t: 'Запаса хватит, дней', kind: 'int', dir: 1, v: (S, ctx) => (S.stockN && ctx.perDay > 0 ? S.stock / ctx.perDay : null) },
  { g: 'Выкуп и прибыль', k: 'buyout', t: 'Выкуп (модель), %', kind: 'pct', dir: 1, v: S => d0(S.bW, S.bN) },
  { g: 'Выкуп и прибыль', k: 'buyQty', t: 'Выкупы, шт', kind: 'int', dir: 1, fin: true, v: S => (S.finAny ? S.buyQty : null) },
  { g: 'Выкуп и прибыль', k: 'buyRub', t: 'Выкупы, ₽', kind: 'rub', dir: 1, fin: true, v: S => (S.finAny ? S.buyRub : null) },
  { g: 'Выкуп и прибыль', k: 'profitF', t: 'Прогноз: прибыль, ₽', kind: 'rub', dir: 1, v: S => (S.fAny ? S.fProfit : null) },
  { g: 'Выкуп и прибыль', k: 'marginF', t: 'Прогноз: маржинальность, %', kind: 'pct', dir: 1, v: S => (S.fAny ? pc(S.fProfit, S.fRev) : null) },
  { g: 'Выкуп и прибыль', k: 'profit', t: 'Прибыль факт, ₽', kind: 'rub', dir: 1, fin: true, tip: true, strong: true, v: S => (S.finAny ? S.profit : null) },
  { g: 'Выкуп и прибыль', k: 'margin', t: 'Маржинальность факт, %', kind: 'pct', dir: 1, fin: true, tip: true, v: S => (S.finAny ? pc(S.profit, S.buyRub) : null) },
];
const MET = Object.fromEntries(METRICS.map(m => [m.k, m]));
const fmt = (v, kind) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : kind === 'pct' ? fmtPct(v) : fmtInt(v));
const LS = 'mp-rnp';
const ld = (k, d) => { try { const v = JSON.parse(localStorage.getItem(`${LS}:${k}`) || 'null'); return v ?? d; } catch (e) { return d; } };
const sv = (k, v) => { try { localStorage.setItem(`${LS}:${k}`, JSON.stringify(v)); } catch (e) { /* ignore */ } };

// Начисления Ozon по артикулу и дню (в датах dates) — как в конструкторе и P&L.
function finByDay(fin, dates) {
  if (!fin) return null;
  const L = dates.length;
  const di = new Map(dates.map((d, i) => [d, i]));
  const pd = fin.dates.map(d => di.get(d));
  const m = new Map();
  const arr = () => new Float64Array(L);
  const get = o => { let x = m.get(o); if (!x) { x = { s: arr(), q: arr(), ad: arr(), b: Object.fromEntries([...OZ, 'ads'].map(k => [k, arr()])), cost: null }; m.set(o, x); } return x; };
  const saleDay = arr(), adDay = arr(), nsOther = arr(), nsAds = arr();
  fin.articles.forEach((a, i) => { if (fin.cost?.[i]) get(a.o).cost = fin.cost[i]; });
  for (const [pai, dd, b, a, q] of fin.rows) {
    const o = fin.articles[pai]?.o, d = pd[dd]; if (!o || d === undefined) continue;
    const k = fin.buckets[b], x = get(o);
    if (k === 'sale' || k === 'return') { x.s[d] += a; saleDay[d] += a; x.q[d] += k === 'sale' ? Math.abs(q) : -Math.abs(q); } else if (x.b[k]) x.b[k][d] += a;
  }
  for (const [pai, dd, v] of fin.ads || []) { const o = fin.articles[pai]?.o, d = pd[dd]; if (!o || d === undefined) continue; get(o).ad[d] += v; adDay[d] += v; }
  let lastFin = -1;
  for (const [dd, b, a] of fin.noSku || []) {
    const d = pd[dd]; if (d === undefined) continue;
    const k = fin.buckets[b];
    if (k === 'ads') { nsAds[d] += a; if (a) lastFin = Math.max(lastFin, d); } else if (OZ.includes(k)) nsOther[d] += a;
  }
  const ai = fin.buckets.indexOf('ads');
  for (const r of fin.rows) if (r[2] === ai && r[3] && pd[r[1]] !== undefined) lastFin = Math.max(lastFin, pd[r[1]]);
  return { m, saleDay, adDay, nsOther, nsAds, lastFin, L };
}

// Суммы по дням для одного артикула: { key: Float64Array(L) }.
function artDays(a, dates, F, ctx) {
  const L = dates.length, S = {};
  for (const k of KEYS) S[k] = new Float64Array(L);
  const x = F?.m.get(a.o);
  const k0 = ctx.coefOf ? ctx.coefOf(a.o) : null;
  const pr = ctx.priceOf ? ctx.priceOf(a.o) : null;
  for (let d = 0; d < L; d++) {
    S.views[d] = a.views[d]; S.pdp[d] = a.pdpViews[d]; S.cart[d] = a.cart[d]; S.orders[d] = a.orders[d]; S.revenue[d] = a.revenue[d];
    S.spendCpc[d] = a.spendCpc[d]; S.spendCpo[d] = a.spendCpo[d]; S.spend[d] = a.spendCpc[d] + a.spendCpo[d];
    S.adOrders[d] = a.adOrders[d]; S.clicks[d] = a.clicks[d];
    if (a.stockArr[d] !== null && a.stockArr[d] !== undefined) { S.stock[d] = a.stockArr[d]; S.stockN[d] = 1; }
    if (k0 && a.orders[d] > 0) { S.bW[d] = k0.buyout * 100 * a.orders[d]; S.bN[d] = a.orders[d]; }
    if (ctx.forecast && (a.orders[d] > 0 || S.spend[d] > 0)) {
      const r = ctx.forecast(a.o, dates[d], a.revenue[d], a.orders[d], S.spend[d]);
      if (r) { S.fProfit[d] = r.profit; S.fRev[d] = r.expRev; S.fAny[d] = 1; }
    }
    const p = pr ? pr[d] : null;
    if (p && p[0]) {
      S.pS[d] = p[0]; S.cS[d] = p[1] || p[0]; S.pN[d] = 1;
      if (a.orders[d] > 0) { S.pW[d] = p[0] * a.orders[d]; S.cW[d] = (p[1] || p[0]) * a.orders[d]; S.wN[d] = a.orders[d]; }
    }
    if (x) finDay(S, x, F, d, a.o, dates, ctx);
  }
  return S;
}
// Прибыль артикула за день (пишет в S[...][d]).
function finDay(S, x, F, d, o, dates, ctx) {
  const s = x.s[d], q = x.q[d];
  const other = F.nsOther[d] * (F.saleDay[d] ? s / F.saleDay[d] : 0);
  const nsA = F.nsAds[d] * (F.adDay[d] > 0 ? x.ad[d] / F.adDay[d] : F.saleDay[d] ? s / F.saleDay[d] : 0);
  const adLate = d > F.lastFin ? x.ad[d] : 0;
  let oz = 0;
  for (const k of OZ) { S['oz_' + k][d] = x.b[k][d]; oz += x.b[k][d]; }
  S.ozAds[d] = x.b.ads[d]; oz += x.b.ads[d];
  const cost = (x.cost || 0) * Math.max(0, q);
  const tax = s ? s * (ctx.shareAt ? (ctx.shareAt(o, dates[d]) ?? 1) : 1) * (ctx.tax || 0) / 100 : 0;
  S.buyQty[d] = q; S.buyRub[d] = s; S.nsOther[d] = other; S.nsAds[d] = nsA; S.adLate[d] = adLate; S.cost[d] = cost; S.tax[d] = tax;
  S.profit[d] = s + oz + other + nsA - adLate - cost - tax;
  if (s || q || oz || adLate) S.finAny[d] = 1;
}
const addInto = (T, S) => { for (const k of KEYS) { const a = T[k], b = S[k]; for (let i = 0; i < a.length; i++) a[i] += b[i]; } };
// Ячейка периода: суммы по набору дней (остаток — последний день с данными).
function bucketSum(S, idx) {
  const out = {};
  for (const k of KEYS) {
    if (LAST.has(k)) continue;
    let v = 0; for (const i of idx) v += S[k][i]; out[k] = v;
  }
  let li = -1; for (const i of idx) if (S.stockN[i] > 0 && i > li) li = i;
  out.stock = li >= 0 ? S.stock[li] : 0; out.stockN = li >= 0 ? S.stockN[li] : 0;
  return out;
}

// Цвет ячейки в строке: зелёный — лучше, красный — хуже (относительно соседних дней).
function heat(vals, dir) {
  if (!dir) return vals.map(() => null);
  const f = vals.filter(v => v !== null && Number.isFinite(v));
  if (f.length < 3) return vals.map(() => null);
  const mn = Math.min(...f), mx = Math.max(...f);
  if (mx - mn < 1e-9) return vals.map(() => null);
  return vals.map(v => {
    if (v === null || !Number.isFinite(v)) return null;
    let t = (v - mn) / (mx - mn); if (dir < 0) t = 1 - t;
    const s = Math.abs(t - 0.5) * 2;
    if (s < 0.12) return null;
    return `color-mix(in srgb, var(${t > 0.5 ? '--a-good' : '--a-bad'}) ${Math.round(6 + s * 24)}%, transparent)`;
  });
}

function Delta({ cur, prev, kind, dir }) {
  if (cur === null || prev === null || cur === undefined || prev === undefined || !Number.isFinite(cur) || !Number.isFinite(prev)) return <span className="muted">—</span>;
  let t, d;
  if (kind === 'pct') { d = cur - prev; if (Math.abs(d) < 0.05) return <span className="muted">0</span>; t = `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1).replace('.', ',')} п.п.`; }
  else { if (!prev) return <span className="muted">—</span>; d = (cur / prev - 1) * 100; if (Math.abs(d) < 0.5) return <span className="muted">0%</span>; t = `${d > 0 ? '+' : '−'}${Math.abs(d) >= 100 ? Math.round(Math.abs(d)) : Math.abs(d).toFixed(0)}%`; }
  const good = dir === 0 ? null : (d > 0) === (dir > 0);
  return <span className={good === null ? '' : good ? 's-up' : 's-down'}>{t}</span>;
}

export default function Rnp({ cabinet, data, arts, fin, finPrev, forecast, shareAt, coefOf, tax, prevDates }) {
  const dates = data.dates;
  const L = dates.length;
  const [gran, setGran] = useState(() => ld('gran', 'day'));
  useEffect(() => { sv('gran', gran); }, [gran]);
  const [mode, setMode] = useState(() => ld('mode', 'cats'));
  useEffect(() => { sv('mode', mode); }, [mode]);
  const [mets, setMets] = useState(() => ld('mets', METRICS.map(m => m.k)));
  useEffect(() => { sv('mets', mets); }, [mets]);
  const [open, setOpen] = useState(() => new Set(['__all']));
  const [more, setMore] = useState({});
  const [pick, setPick] = useState(false);
  const pickRef = useRef(null);
  useEffect(() => {
    if (!pick) return undefined;
    const on = e => { if (pickRef.current && !pickRef.current.contains(e.target)) setPick(false); };
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [pick]);

  // Группы «Рекламы», «В пути», цены по дням.
  const [groups, setGroups] = useState(null);
  const [transit, setTransit] = useState({});
  const [prices, setPrices] = useState(null);
  useEffect(() => {
    getAdsGroups(cabinet).then(r => setGroups(r.data.data || { groups: [], members: {} })).catch(() => setGroups({ groups: [], members: {} }));
    getAdsTransit(cabinet).then(r => setTransit(r.data.data || {})).catch(() => {});
  }, [cabinet]);
  useEffect(() => {
    const days = Math.min(400, dayjs().diff(dayjs(dates[0]), 'day') + 2);
    getPriceDynamics(cabinet, days).then(r => setPrices(r.data.data)).catch(() => setPrices(false));
  }, [cabinet, dates[0]]); // eslint-disable-line react-hooks/exhaustive-deps
  const priceOf = useMemo(() => {
    if (!prices) return null;
    const f0 = dayjs(prices.from), idx = dates.map(d => dayjs(d).diff(f0, 'day'));
    const cache = new Map();
    return o => {
      if (cache.has(o)) return cache.get(o);
      const pts = prices.items[o]; let out = null;
      if (pts && pts.length) {
        out = new Array(L).fill(null); let j = 0, cur = null;
        for (let d = 0; d < L; d++) { while (j < pts.length && pts[j][0] <= idx[d]) { cur = pts[j]; j++; } out[d] = cur ? [cur[1], cur[2]] : null; }
      }
      cache.set(o, out); return out;
    };
  }, [prices, dates, L]);

  const F = useMemo(() => finByDay(fin, dates), [fin, dates]);
  const ctx = useMemo(() => ({ coefOf, forecast, shareAt, tax, priceOf }), [coefOf, forecast, shareAt, tax, priceOf]);
  const perArt = useMemo(() => new Map(arts.map(a => [a.o, artDays(a, dates, F, ctx)])), [arts, dates, F, ctx]);
  // Прошлый период — итоги по артикулу (заказы и трафик из data.prev, прибыль — из начислений прошлого периода).
  const Fp = useMemo(() => (finPrev && prevDates ? finByDay(finPrev, prevDates) : null), [finPrev, prevDates]);
  const prevOf = useMemo(() => {
    const m = new Map();
    for (const a of arts) {
      const p = a.prev; const P = Object.fromEntries(KEYS.map(k => [k, 0]));
      if (p) { P.views = p.views; P.pdp = p.pdpViews; P.cart = p.cart; P.orders = p.orders; P.revenue = p.revenue; P.spend = p.spend; P.adOrders = p.adOrders; P.has = 1; }
      const x = Fp && Fp.m.get(a.o);
      if (x) {
        const S = {}; for (const k of KEYS) S[k] = new Float64Array(prevDates.length);
        for (let d = 0; d < prevDates.length; d++) finDay(S, x, Fp, d, a.o, prevDates, { shareAt, tax });
        for (const k of ['buyQty', 'buyRub', 'profit', 'finAny']) { let v = 0; for (const y of S[k]) v += y; P[k] = v; }
        P.hasFin = 1;
      }
      m.set(a.o, P);
    }
    return m;
  }, [arts, Fp, prevDates, shareAt, tax]);

  // Дерево: категории или группы «Рекламы».
  const tree = useMemo(() => {
    const root = { key: '__all', name: 'Итого', arts: arts.map(a => a.o), kids: [], depth: 0 };
    const byKey = new Map([['__all', root]]);
    if (mode === 'groups' && groups) {
      const gl = new Map(groups.groups.map(g => [String(g.id), { key: 'g:' + g.id, name: g.name, arts: [], kids: [], depth: 1 }]));
      const none = { key: 'g:none', name: 'Без группы', arts: [], kids: [], depth: 1 };
      for (const a of arts) { const g = gl.get(String(groups.members[a.o] || '')); (g || none).arts.push(a.o); }
      for (const g of [...gl.values(), none]) if (g.arts.length) { root.kids.push(g); byKey.set(g.key, g); }
    } else {
      for (const a of arts) {
        let parent = root;
        a.parts.forEach((p, i) => {
          const key = 'c:' + a.parts.slice(0, i + 1).join(SEP);
          let n = byKey.get(key);
          if (!n) { n = { key, name: p, arts: [], kids: [], depth: i + 1 }; byKey.set(key, n); parent.kids.push(n); }
          n.arts.push(a.o); parent = n;
        });
      }
    }
    return { root, byKey };
  }, [arts, mode, groups]);

  const artBy = useMemo(() => new Map(arts.map(a => [a.o, a])), [arts]);
  const totalsCache = useMemo(() => new Map(), [perArt, tree]); // eslint-disable-line react-hooks/exhaustive-deps
  const daysOf = (key, list) => {
    let T = totalsCache.get(key);
    if (T) return T;
    T = {}; for (const k of KEYS) T[k] = new Float64Array(L);
    for (const o of list) { const S = perArt.get(o); if (S) addInto(T, S); }
    totalsCache.set(key, T);
    return T;
  };
  const prevSum = list => {
    const P = Object.fromEntries(KEYS.map(k => [k, 0])); let has = 0, hasFin = 0;
    for (const o of list) { const p = prevOf.get(o); if (!p) continue; for (const k of KEYS) P[k] += p[k] || 0; has |= p.has || 0; hasFin |= p.hasFin || 0; }
    return { P, has, hasFin };
  };

  const buckets = useMemo(() => {
    let b;
    if (gran === 'day') b = dates.map((d, i) => ({ key: d, idx: [i] }));
    else {
      const map = new Map();
      dates.forEach((d, i) => { const k = gran === 'week' ? dayjs(d).subtract((dayjs(d).day() + 6) % 7, 'day').format('YYYY-MM-DD') : d.slice(0, 8) + '01'; if (!map.has(k)) map.set(k, []); map.get(k).push(i); });
      b = [...map.entries()].map(([key, idx]) => ({ key, idx }));
    }
    return b.reverse(); // свежие слева
  }, [dates, gran]);
  const allIdx = useMemo(() => dates.map((_, i) => i), [dates]);
  const bLabel = b => {
    const d = dayjs(b.key);
    if (gran === 'day') return { t: d.format('DD.MM'), s: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][d.day()], we: d.day() === 0 || d.day() === 6 };
    if (gran === 'week') return { t: `${d.format('DD.MM')}–${d.add(6, 'day').format('DD.MM')}`, s: `нед · ${b.idx.length} дн` };
    return { t: d.format('MM.YYYY'), s: `${b.idx.length} дн` };
  };

  // Подсказка с раскладкой прибыли.
  const [tip, setTip] = useState(null);
  const showTip = (e, S, title) => {
    if (!S || !S.finAny) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ x: Math.min(window.innerWidth - 360, r.right + 8), y: Math.max(8, Math.min(window.innerHeight - 440, r.top - 120)), S, title });
  };

  const shownMets = METRICS.filter(m => mets.includes(m.k));
  const fullL = L || 1;

  const block = (node, depth, isArt) => {
    const list = node.arts;
    const T = daysOf(node.key, list);
    const tot = bucketSum(T, allIdx);
    const { P, has, hasFin } = prevSum(list);
    const cells = buckets.map(b => bucketSum(T, b.idx));
    const perDayTot = tot.orders / fullL;
    const tr = list.reduce((s, o) => s + (Number(transit[o]?.q) || 0), 0);
    const kids = isArt ? [] : node.kids.length ? node.kids : list.map(o => ({ key: 'a:' + o, o, name: o, arts: [o], kids: [], art: true }));
    const isOpen = open.has(node.key);
    const a = isArt ? artBy.get(node.o) : null;
    const toggle = () => setOpen(s => { const n = new Set(s); if (n.has(node.key)) n.delete(node.key); else n.add(node.key); return n; });
    // Дети: сортировка по заказам ₽ за период, первые 20 + «ещё».
    let kidRows = null;
    if (isOpen && kids.length) {
      const sorted = [...kids].map(k => ({ k, rev: k.arts.reduce((s, o) => { const S = perArt.get(o); if (!S) return s; let v = 0; for (const x of S.revenue) v += x; return s + v; }, 0) })).sort((x, y) => y.rev - x.rev).map(x => x.k);
      const lim = more[node.key] || 20;
      kidRows = (
        <>
          {sorted.slice(0, lim).map(k => block(k, depth + 1, !!k.art))}
          {sorted.length > lim && (
            <tbody className="rnp-more"><tr><td colSpan={5 + buckets.length}>
              <button type="button" className="s-fold" style={{ marginLeft: 12 + (depth + 1) * 14 }} onClick={() => setMore(m => ({ ...m, [node.key]: lim + 30 }))}>Показать ещё {Math.min(30, sorted.length - lim)} из {sorted.length - lim} ▼</button>
            </td></tr></tbody>
          )}
        </>
      );
    }
    return (
      <React.Fragment key={node.key}>
        <tbody className={`rnp-block ${depth === 0 ? 'top' : ''} ${isArt ? 'art' : ''}`}>
          {shownMets.map((m, mi) => {
            // «Запаса хватит» — от средних заказов в день за весь период.
            const vals = cells.map(S => m.v(S, { perDay: perDayTot }));
            const hs = heat(vals, m.dir);
            const vTot = m.k === 'transit' ? (tr || null) : m.k === 'cover' ? (tot.stockN && perDayTot > 0 ? tot.stock / perDayTot : null) : m.v(tot, { perDay: perDayTot });
            const prevOk = m.fin ? hasFin : has;
            const vPrev = !prevOk || ['stock', 'cover', 'transit', 'price', 'client', 'spp', 'buyout', 'profitF', 'marginF'].includes(m.k) ? null : m.v(P, { perDay: 0 });
            const finMissing = m.fin && !fin;
            return (
              <tr key={m.k} className={`${m.strong ? 'rnp-strong' : ''} ${mi === 0 ? 'rnp-first' : ''}`}>
                {mi === 0 && (
                  <td className="rnp-name" rowSpan={shownMets.length} style={{ paddingLeft: 10 + depth * 14 }}>
                    <div className="rnp-nm">
                      {!isArt && kids.length > 0 && <button type="button" className={`rnp-chev ${isOpen ? 'on' : ''}`} onClick={toggle} title={isOpen ? 'Свернуть' : 'Раскрыть'}>▶</button>}
                      <div style={{ minWidth: 0 }}>
                        <div className="rnp-ti" title={node.name}>{isArt ? node.o : node.name}</div>
                        <div className="rnp-s">{isArt ? (a?.short || '') : `${list.length} арт.`}</div>
                        {isArt && a?.cat && <div className="rnp-s" title={a.cat}>{a.parts?.slice(-1)[0]}</div>}
                      </div>
                    </div>
                  </td>
                )}
                <td className="rnp-m">{m.t}</td>
                <td className="n r rnp-tot">{finMissing ? '…' : fmt(vTot, m.kind)}</td>
                <td className="n r rnp-prev">{m.now || finMissing ? '' : fmt(vPrev, m.kind)}</td>
                <td className="n r rnp-dyn">{m.now || finMissing ? '' : <Delta cur={vTot} prev={vPrev} kind={m.kind} dir={m.dir} />}</td>
                {cells.map((S, i) => (
                  <td key={i} className={`n r ${m.tip ? 'rnp-tipc' : ''}`} style={hs[i] ? { background: hs[i] } : undefined}
                    onMouseEnter={m.tip ? e => showTip(e, S, `${isArt ? node.o : node.name} · ${bLabel(buckets[i]).t}`) : undefined} onMouseLeave={m.tip ? () => setTip(null) : undefined}>
                    {m.now ? '' : finMissing ? '…' : fmt(vals[i], m.kind)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
        {kidRows}
      </React.Fragment>
    );
  };

  const groupsList = [...new Set(METRICS.map(m => m.g))];
  const T = tip?.S;
  const tipRows = T ? [
    ['Выкупы (за вычетом возвратов)', T.buyRub, true],
    ...OZ.map(k => [OZ_T[k], T['oz_' + k]]),
    ['Прочее без артикула (доля)', T.nsOther],
    ['Реклама', T.ozAds + T.nsAds - T.adLate],
    ['Себестоимость', -T.cost],
    ['Налог', -T.tax],
  ].filter(r => r[2] || Math.abs(r[1]) >= 0.5) : [];

  return (
    <div className="rnp">
      <div className="a-bar" style={{ gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
        <span className="tb-lbl" style={{ width: 'auto' }}>Группировка</span>
        <span className="a-seg">{[['cats', 'Категории'], ['groups', 'Группы «Рекламы»']].map(([k, t]) => <button key={k} type="button" className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{t}</button>)}</span>
        <span className="a-seg">{[['day', 'Дни'], ['week', 'Недели'], ['month', 'Месяцы']].map(([k, t]) => <button key={k} type="button" className={gran === k ? 'on' : ''} onClick={() => setGran(k)}>{t}</button>)}</span>
        <span className="tb-tplwrap" ref={pickRef}>
          <button type="button" className="a-btn" onClick={() => setPick(p => !p)}>Метрики · {shownMets.length} ▾</button>
          {pick && (
            <div className="tb-tplpop rnp-pick">
              {groupsList.map(g => (
                <div key={g} className="rnp-pg">
                  <div className="rnp-pgt">{g}</div>
                  {METRICS.filter(m => m.g === g).map(m => (
                    <label key={m.k} className="tb-chk" style={{ display: 'flex', padding: '2px 0' }}>
                      <input type="checkbox" checked={mets.includes(m.k)} onChange={e => setMets(x => (e.target.checked ? METRICS.map(y => y.k).filter(k => x.includes(k) || k === m.k) : x.filter(k => k !== m.k)))} />{m.t}
                    </label>
                  ))}
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button type="button" className="a-btn ghost" onClick={() => setMets(METRICS.map(m => m.k))}>все</button>
                <button type="button" className="a-btn ghost" onClick={() => setMets(['orders', 'revenue', 'spend', 'drr', 'stock', 'profitF', 'profit', 'margin'])}>главное</button>
              </div>
            </div>
          )}
        </span>
        <button type="button" className="a-btn ghost" onClick={() => setOpen(new Set(['__all']))}>свернуть всё</button>
        <span className="a-hint" style={{ margin: 0 }}>▶ — раскрыть до подкатегорий и артикулов · ячейки: зеленее — лучше, краснее — хуже · наведите на прибыль — раскладка{!fin ? ' · начисления Ozon загружаются…' : ''}</span>
      </div>
      <div className="a-card rnp-card">
        <div className="a-scroll rnp-scroll">
          <table className="a-t rnp-t">
            <thead><tr>
              <th className="rnp-name l">Группа / артикул</th>
              <th className="rnp-m l">Метрика</th>
              <th className="r rnp-tot">Итого</th>
              <th className="r rnp-prev" title="Такой же по длине период перед выбранным">Пред. период</th>
              <th className="r rnp-dyn">Динамика</th>
              {buckets.map(b => { const l = bLabel(b); return <th key={b.key} className={`r rnp-d ${l.we ? 'we' : ''}`}><div>{l.t}</div><small>{l.s}</small></th>; })}
            </tr></thead>
            {block(tree.root, 0, false)}
          </table>
        </div>
      </div>
      {tip && T && (
        <div className="rnp-tip" style={{ left: tip.x, top: tip.y }}>
          <div className="rnp-tipt">Прибыль · {tip.title}</div>
          {tipRows.map(([t, v, head]) => (
            <div key={t} className={`rnp-tr ${head ? 'h' : ''}`}><span>{t}</span><b>{fmtInt(v)} ₽</b><i>{T.buyRub ? fmtPct((v / T.buyRub) * 100) : ''}</i></div>
          ))}
          <div className="rnp-tr tot"><span>Прибыль</span><b className={T.profit < 0 ? 's-down' : 's-up'}>{fmtInt(T.profit)} ₽</b><i>{T.buyRub ? fmtPct((T.profit / T.buyRub) * 100) : ''}</i></div>
          <div className="rnp-tipn">% — от выкупов. Как в «P&L»: начисления Ozon дня; реклама за дни, которые Ozon ещё не провёл, — из кабинета.</div>
        </div>
      )}
    </div>
  );
}
