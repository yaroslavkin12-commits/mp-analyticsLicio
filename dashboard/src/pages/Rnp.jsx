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
const KEYS = ['selfQ', 'selfR', 'views', 'pdp', 'cart', 'orders', 'revenue', 'spend', 'spendCpc', 'spendCpo', 'adOrders', 'clicks', 'adViews', 'stock', 'stockN',
  'buyQty', 'buyRub', 'nsSale', ...OZ.map(k => 'oz_' + k), 'ozAds', 'nsOther', 'nsAds', 'adLate', 'cost', 'taxBase', 'finAny',
  'fProfit', 'fRev', 'fAny', 'fPay', 'fQty', 'bW', 'bN', 'pW', 'cW', 'wN', 'pS', 'cS', 'pN'];
const LAST = new Set(['stock', 'stockN']); // остаток — на конец периода, а не сумма

const d0 = (a, b) => (b ? a / b : null);
const pc = (a, b) => (b ? (a / b) * 100 : null);
// dir: 1 — больше лучше, -1 — меньше лучше, 0 — без подсветки.
// Разделы таблицы. key — строка видна и в свёрнутом разделе («кратко»).
const SECTIONS = ['Заказы', 'Воронка', 'Реклама', 'Прибыль ПРОГНОЗ', 'Прибыль ФАКТ'];
const buyPct = S => d0(S.bW, S.bN); // % выкупа (модель), взвешенный по заказам
const priceP = S => (S.wN ? S.pW / S.wN : d0(S.pS, S.pN)), priceC = S => (S.wN ? S.cW / S.wN : d0(S.cS, S.pN));
const METRICS = [
  { g: 'Заказы', k: 'orders', t: 'Заказы, шт', kind: 'int', dir: 1, key: true, strong: true, v: S => S.orders },
  { g: 'Заказы', k: 'revenue', t: 'Заказы, ₽', kind: 'rub', dir: 1, key: true, strong: true, v: S => S.revenue },
  { g: 'Заказы', k: 'spp', t: 'СПП, %', kind: 'pct', dir: 0, key: true, v: S => { const p = priceP(S), c = priceC(S); return p && c ? (1 - c / p) * 100 : null; } },
  { g: 'Заказы', k: 'buyout', t: 'Выкуп, %', kind: 'pct', dir: 1, key: true, v: S => buyPct(S) },
  { g: 'Заказы', k: 'avgCheck', t: 'Средний чек, ₽', kind: 'rub', dir: 0, key: true, v: S => d0(S.revenue, S.orders) },
  { g: 'Заказы', k: 'stock', t: 'Остаток, шт', kind: 'int', dir: 0, v: S => (S.stockN ? S.stock : null) },
  { g: 'Заказы', k: 'cover', t: 'Хватит на, дней', kind: 'int', dir: 1, v: (S, ctx) => (S.stockN && ctx.perDay > 0 ? S.stock / ctx.perDay : null) },
  { g: 'Заказы', k: 'transit', t: 'В пути, шт', kind: 'int', dir: 0, now: true, v: () => null },
  { g: 'Заказы', k: 'selfQ', t: 'Самовыкупы, шт (не в заказах)', kind: 'int', dir: 0, v: S => S.selfQ },
  { g: 'Заказы', k: 'selfR', t: 'Самовыкупы, ₽', kind: 'rub', dir: 0, off: true, v: S => S.selfR },
  { g: 'Заказы', k: 'price', t: 'Цена до СПП, ₽', kind: 'rub', dir: 0, off: true, v: S => priceP(S) },
  { g: 'Заказы', k: 'client', t: 'Цена после СПП, ₽', kind: 'rub', dir: 0, off: true, v: S => priceC(S) },
  { g: 'Воронка', k: 'views', t: 'Показы', kind: 'int', dir: 1, v: S => S.views },
  { g: 'Воронка', k: 'pdp', t: 'Клики (переходы в карточку)', kind: 'int', dir: 1, v: S => S.pdp },
  { g: 'Воронка', k: 'cart', t: 'Корзины, шт', kind: 'int', dir: 1, key: true, v: S => S.cart },
  { g: 'Воронка', k: 'fOrders', t: 'Заказы, шт', kind: 'int', dir: 1, v: S => S.orders },
  { g: 'Воронка', k: 'ctr', t: 'CTR (показ → клик), %', kind: 'pct', dir: 1, v: S => pc(S.pdp, S.views) },
  { g: 'Воронка', k: 'crCart', t: 'CR в корзину, %', kind: 'pct', dir: 1, v: S => pc(S.cart, S.pdp) },
  { g: 'Воронка', k: 'crOrder', t: 'CR в заказ, %', kind: 'pct', dir: 1, v: S => pc(S.orders, S.cart) },
  { g: 'Реклама', k: 'spend', t: 'Расход, ₽', kind: 'rub', dir: 0, key: true, v: S => S.spend },
  { g: 'Реклама', k: 'drr', t: 'ДРР от заказов, %', kind: 'pct', dir: -1, key: true, v: S => pc(S.spend, S.revenue) },
  { g: 'Реклама', k: 'drrB', t: 'ДРР с учётом выкупа, %', kind: 'pct', dir: -1, v: S => { const b = buyPct(S); return b ? pc(S.spend, S.revenue * b / 100) : null; } },
  { g: 'Реклама', k: 'adOrders', t: 'Заказы с рекламы, шт', kind: 'int', dir: 1, v: S => S.adOrders },
  { g: 'Реклама', k: 'adShare', t: 'Доля заказов с рекламы, %', kind: 'pct', dir: 0, v: S => pc(S.adOrders, S.orders) },
  { g: 'Реклама', k: 'adCtr', t: 'CTR рекламы, %', kind: 'pct', dir: 1, v: S => pc(S.clicks, S.adViews) },
  { g: 'Прибыль ПРОГНОЗ', k: 'profitF', t: 'Прогноз прибыли, ₽', kind: 'rub', dir: 1, key: true, v: S => (S.fAny ? S.fProfit : null) },
  { g: 'Прибыль ПРОГНОЗ', k: 'marginF', t: 'Прогноз маржинальности, %', kind: 'pct', dir: 1, key: true, v: S => (S.fAny ? pc(S.fProfit, S.fRev) : null) },
  { g: 'Прибыль ПРОГНОЗ', k: 'payF', t: 'Ср. поступ. на счёт ПРОГНОЗ, ₽', h: 'Средняя сумма поступления на счёт за один выкуп по прогнозу: ожидаемая выручка минус комиссия, логистика, эквайринг, прочие услуги и реклама', kind: 'rub', dir: 1, key: true, strong: true, v: S => (S.fAny && S.fQty > 0 ? S.fPay / S.fQty : null) },
  { g: 'Прибыль ФАКТ', k: 'buyQty', t: 'Выкупы, шт', kind: 'int', dir: 1, fin: true, key: true, v: S => (S.finAny ? S.buyQty : null) },
  { g: 'Прибыль ФАКТ', k: 'buyRub', t: 'Выручка, ₽', kind: 'rub', dir: 1, fin: true, key: true, v: S => (S.finAny ? S.buyRub : null) },
  { g: 'Прибыль ФАКТ', k: 'profit', t: 'Чистая прибыль, ₽', kind: 'rub', dir: 1, fin: true, tip: true, strong: true, key: true, v: S => (S.finAny ? S.profit : null) },
  { g: 'Прибыль ФАКТ', k: 'margin', t: 'Маржинальность, %', kind: 'pct', dir: 1, fin: true, tip: true, key: true, v: S => (S.finAny ? pc(S.profit, S.buyRub + S.nsSale) : null) },
  { g: 'Прибыль ФАКТ', k: 'payA', t: 'Ср. поступ. на счёт ФАКТ, ₽', h: 'Средняя сумма поступления на счёт за один выкуп по начислениям Ozon: к перечислению / выкупы', kind: 'rub', dir: 1, fin: true, key: true, strong: true, v: S => (S.finAny && S.buyQty > 0 ? S.payout / S.buyQty : null) },
];
const MET = Object.fromEntries(METRICS.map(m => [m.k, m]));
const fmt = (v, kind) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : kind === 'pct' ? fmtPct(v) : fmtInt(v));
const LS = 'mp-rnp';
const ld = (k, d) => { try { const v = JSON.parse(localStorage.getItem(`${LS}:${k}`) || 'null'); return v ?? d; } catch (e) { return d; } };
const sv = (k, v) => { try { localStorage.setItem(`${LS}:${k}`, JSON.stringify(v)); } catch (e) { /* ignore */ } };

// Начисления Ozon по артикулу и дню (в датах dates) — тем же способом, что «Фактическая
// прибыль» в «Аналитике продаж» (= «P&L»): удержания и продажи без артикула — по доле
// выручки дня; реклама без артикула — по доле расхода кабинета за период; реклама за
// дни, которые Ozon ещё не провёл, — из кабинета; налог — по дням, день с
// отрицательной базой — 0.
function finByDay(fin, dates) {
  if (!fin) return null;
  const L = dates.length;
  const di = new Map(dates.map((d, i) => [d, i]));
  const pd = fin.dates.map(d => di.get(d));
  const m = new Map();
  const arr = () => new Float64Array(L);
  const get = o => { let x = m.get(o); if (!x) { x = { s: arr(), q: arr(), ad: arr(), self: arr(), b: Object.fromEntries([...OZ, 'ads'].map(k => [k, arr()])), cost: null, sTot: 0 }; if(fin._operational){for(const a of Object.values(x.b))a.fill(NaN);} m.set(o, x); } return x; };
  const saleDay = arr(), nsOther = arr(), nsSale = arr();
  let saleAll = 0, adsAll = 0, nsAdsTot = 0;
  fin.articles.forEach((a, i) => { if (fin.cost?.[i]) get(a.o).cost = fin.cost[i]; });
  const ai = fin.buckets.indexOf('ads');
  let lastFin = -1; // последний день (индекс начислений), когда реклама уже проведена
  for (const r of fin.rows) if (r[2] === ai && r[3]) lastFin = Math.max(lastFin, r[1]);
  for (const [dd, b, a] of fin.noSku || []) if (b === ai && a) lastFin = Math.max(lastFin, dd);
  for (const [pai, dd, b, a, q] of fin.rows) {
    const o = fin.articles[pai]?.o, d = pd[dd]; if (!o || d === undefined) continue;
    const k = fin.buckets[b], x = get(o);
    if (k === 'sale' || k === 'return') { x.s[d] += a; x.sTot += a; saleDay[d] += a; saleAll += a; x.q[d] += k === 'sale' ? Math.abs(q) : -Math.abs(q); } else if (x.b[k]) x.b[k][d] += a;
  }
  const late = new Uint8Array(L);
  fin.dates.forEach((_, dd) => { const d = pd[dd]; if (d !== undefined && dd > lastFin) late[d] = 1; });
  for (const [pai, dd, v] of fin.ads || []) { const o = fin.articles[pai]?.o, d = pd[dd]; if (!o || d === undefined) continue; get(o).ad[d] += v; adsAll += v; }
  for (const [pai, dd, q] of fin.self || []) { const o = fin.articles[pai]?.o, d = pd[dd]; if (!o || d === undefined) continue; get(o).self[d] += q; } // самовыкупы — без себестоимости
  for (const [dd, b, a] of fin.noSku || []) {
    const d = pd[dd]; if (d === undefined) continue;
    const k = fin.buckets[b];
    if (k === 'ads') nsAdsTot += a; else if (OZ.includes(k)) nsOther[d] += a; else if (k === 'sale' || k === 'return') nsSale[d] += a;
  }
  (fin.adNoSku || []).forEach((v, dd) => { const d = pd[dd]; if (d !== undefined && dd > lastFin && v) nsOther[d] -= v; });
  return { operational:fin._operational, available:fin.available, m, saleDay, nsOther, nsSale, nsAdsTot, adsAll, saleAll, late, L };
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
    S.spendCpc[d] = a.spendCpc[d]; S.spendCpo[d] = a.spendCpo[d]; S.spend[d] = a.spendCpc[d] + a.spendCpo[d] + (a.spendOther?.[d] ?? 0);
    S.adOrders[d] = a.adOrders[d]; S.clicks[d] = a.clicks[d]; S.adViews[d] = a.adViews ? a.adViews[d] : 0;
    const sf = ctx.selfOf ? ctx.selfOf(a.i) : null;
    if (sf && sf[d]) { S.selfQ[d] = sf[d][0]; S.selfR[d] = sf[d][1]; }
    if (a.stockArr[d] !== null && a.stockArr[d] !== undefined) { S.stock[d] = a.stockArr[d]; S.stockN[d] = 1; }
    if (k0 && a.orders[d] > 0) { S.bW[d] = k0.buyout * 100 * a.orders[d]; S.bN[d] = a.orders[d]; }
    if (ctx.forecast && (a.orders[d] > 0 || S.spend[d] > 0)) {
      const r = ctx.forecast(a.o, dates[d], a.revenue[d], a.orders[d], S.spend[d]);
      if (r) { S.fProfit[d] = r.profit; S.fRev[d] = r.expRev; S.fAny[d] = 1; S.fPay[d] = r.expRev - r.comm - r.logi - r.acq - r.other - (r.ads || 0) - (r.selfCost || 0); S.fQty[d] = r.expQty || 0; }
    }
    const p = pr ? pr[d] : null;
    if (p && p[0]) {
      S.pS[d] = p[0]; S.cS[d] = p[1] || p[0]; S.pN[d] = 1;
      if (a.orders[d] > 0) { S.pW[d] = p[0] * a.orders[d]; S.cW[d] = (p[1] || p[0]) * a.orders[d]; S.wN[d] = a.orders[d]; }
    }
    if (F?.operational) {
      const known=F.available?.mn&&dates[d]>=F.available.mn&&dates[d]<=F.available.mx;
      S.buyQty[d]=known?(x?.q[d]??0):NaN;S.buyRub[d]=known?(x?.s[d]??0):NaN;S.finAny[d]=known?1:0;
      for(const key of [...OZ.map(k=>'oz_'+k),'ozAds','cost','taxBase','nsOther','nsAds','adLate']) S[key][d]=NaN;
    } else if (x) finDay(S, x, F, d, a.o, dates, ctx);
  }
  return S;
}
// Начисления артикула за день (пишет в S[...][d]); прибыль считается на уровне ячейки (bucketSum).
function finDay(S, x, F, d, o, dates, ctx) {
  const s = x.s[d], q = x.q[d];
  const sh = F.saleDay[d] > 0 ? s / F.saleDay[d] : F.saleAll > 0 ? x.sTot / F.saleAll : 0;
  const nsA = F.nsAdsTot * (F.adsAll > 0 ? x.ad[d] / F.adsAll : F.saleAll > 0 ? s / F.saleAll : 0);
  const adLate = F.late[d] ? x.ad[d] : 0;
  let any = 0;
  for (const k of OZ) { S['oz_' + k][d] = x.b[k][d]; any ||= x.b[k][d]; }
  S.ozAds[d] = x.b.ads[d];
  const k0 = ctx.coefOf ? ctx.coefOf(o) : null;
  const cost = (k0?.cost || x.cost || 0) * (q - x.self[d]);
  S.buyQty[d] = q; S.buyRub[d] = s; S.nsSale[d] = F.nsSale[d] * sh; S.nsOther[d] = F.nsOther[d] * sh; S.nsAds[d] = nsA; S.adLate[d] = adLate; S.cost[d] = cost;
  S.taxBase[d] = s ? s * (ctx.shareAt ? (ctx.shareAt(o, dates[d]) ?? 1) : 1) : 0;
  if (s || q || any || x.b.ads[d] || adLate || S.nsOther[d] || nsA) S.finAny[d] = 1;
}
const addInto = (T, S) => { for (const k of KEYS) { const a = T[k], b = S[k]; for (let i = 0; i < a.length; i++) a[i] += b[i]; } };
// Ячейка периода: суммы по набору дней (остаток — последний день с данными).
function bucketSum(S, idx, taxPct) {
  const out = {};
  for (const k of KEYS) {
    if (LAST.has(k)) continue;
    let v = 0; for (const i of idx) v += S[k][i]; out[k] = v;
  }
  let li = -1; for (const i of idx) if (S.stockN[i] > 0 && i > li) li = i;
  out.stock = li >= 0 ? S.stock[li] : 0; out.stockN = li >= 0 ? S.stockN[li] : 0;
  // Налог — по дням (день с отрицательной базой — 0), прибыль — как в «P&L».
  let tb = 0; for (const i of idx) if (S.taxBase[i] > 0) tb += S.taxBase[i];
  out.tax = tb * (taxPct || 0) / 100;
  let oz = out.ozAds; for (const k of OZ) oz += out['oz_' + k];
  out.profit = out.buyRub + out.nsSale + oz + out.nsOther + out.nsAds - out.adLate - out.cost - out.tax;
  // К перечислению: выкупы минус всё, что удержал Ozon (включая рекламу), — как в «Сводке по магазинам».
  out.payout = out.buyRub + out.nsSale + oz + out.nsOther + out.nsAds - out.adLate;
  return out;
}

// Цвет ячейки в строке: зелёный — лучше, красный — хуже (относительно соседних дней).
function heat(vals, dir, skip) {
  const f = vals.filter((v, i) => !skip[i] && v !== null && Number.isFinite(v));
  if (f.length < 2) return vals.map(() => null);
  const mn = Math.min(...f), mx = Math.max(...f);
  return vals.map((v, i) => {
    if (v === null || !Number.isFinite(v)) return null;
    // Без «лучше/хуже» (расход, остаток, СПП…) — один цвет, ярче там, где значение больше.
    if (!dir) { const t = mx - mn < 1e-9 ? 0.5 : (v - mn) / (mx - mn); return `color-mix(in srgb, var(--a-warn) ${Math.round(8 + t * 22)}%, transparent)`; }
    // Красный — хуже, жёлтый — средне, зелёный — лучше (относительно остальных дней строки).
    let t = mx - mn < 1e-9 ? 0.5 : (v - mn) / (mx - mn); if (dir < 0) t = 1 - t;
    const c = t < 0.4 ? '--a-bad' : t > 0.6 ? '--a-good' : '--a-warn';
    const s = c === '--a-warn' ? 0.35 : Math.abs(t - 0.5) * 2;
    return `color-mix(in srgb, var(${c}) ${Math.round(12 + s * 22)}%, transparent)`;
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
  const [mets, setMets] = useState(() => ld('mets2', METRICS.filter(m => !m.off).map(m => m.k)));
  useEffect(() => { sv('mets2', mets); }, [mets]);
  // Раскрытые разделы (остальные — только главные строки).
  const [secOpen, setSecOpen] = useState(() => ld('secs', { 'Заказы': true }));
  useEffect(() => { sv('secs', secOpen); }, [secOpen]);
  // Какие строки видны в «кратком» виде — настраивается (★ в «Строки»).
  const [keyList, setKeyList] = useState(() => ld('keys', METRICS.filter(m => m.key).map(m => m.k)));
  useEffect(() => { sv('keys', keyList); }, [keyList]);
  const keysOn = new Set(keyList);
  // Раскладка чистой прибыли по статьям (клик по строке).
  const [profOpen, setProfOpen] = useState(() => ld('prof', false));
  useEffect(() => { sv('prof', profOpen); }, [profOpen]);
  // Что показываем: узел дерева (категория / группа) и, при выборе, один артикул.
  const [sel, setSel] = useState('__all');
  const [selArt, setSelArt] = useState('');
  useEffect(() => { setSel('__all'); setSelArt(''); }, [mode, cabinet]);
  const [pick, setPick] = useState(false);
  // Свежие дни справа — при открытии и смене периода прокручиваем таблицу к концу.
  const scrollRef = useRef(null);
  useEffect(() => { const el = scrollRef.current; if (el) requestAnimationFrame(() => { el.scrollLeft = el.scrollWidth; }); }, [dates.length, dates[0], gran]); // eslint-disable-line react-hooks/exhaustive-deps
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
    const days = Math.min(400, dayjs().diff(dayjs(prevDates && prevDates[0] ? prevDates[0] : dates[0]), 'day') + 2);
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
  // Цены прошлого периода по артикулу: суммы [цена до СПП, после СПП, дней с ценой].
  const pricePrev = useMemo(() => {
    if (!prices || !prevDates || !prevDates.length) return null;
    const f0 = dayjs(prices.from), idx = prevDates.map(d => dayjs(d).diff(f0, 'day'));
    return o => {
      const pts = prices.items[o]; if (!pts || !pts.length) return null;
      let j = 0, cur = null, pS = 0, cS = 0, n = 0;
      for (const t of idx) { while (j < pts.length && pts[j][0] <= t) { cur = pts[j]; j++; } if (cur && cur[1]) { pS += cur[1]; cS += cur[2] || cur[1]; n++; } }
      return n ? [pS, cS, n] : null;
    };
  }, [prices, prevDates]);

  const F = useMemo(() => finByDay(fin, dates), [fin, dates]);
  // Самовыкупы по дню заказа (уже вычтены из заказов): ai → { d: [шт, ₽] }.
  const selfMap = useMemo(() => { const m = new Map(); for (const [ai, d, q, r] of data.self || []) { let x = m.get(ai); if (!x) { x = {}; m.set(ai, x); } x[d] = [q, r]; } return m; }, [data]);
  const ctx = useMemo(() => ({ coefOf, forecast, shareAt, tax, priceOf, selfOf: ai => selfMap.get(ai) || null }), [coefOf, forecast, shareAt, tax, priceOf, selfMap]);
  const perArt = useMemo(() => new Map(arts.map(a => [a.o, artDays(a, dates, F, ctx)])), [arts, dates, F, ctx]);
  // Прошлый период — итоги по артикулу (заказы и трафик из data.prev, прибыль — из начислений прошлого периода).
  const Fp = useMemo(() => (finPrev && prevDates ? finByDay(finPrev, prevDates) : null), [finPrev, prevDates]);
  const prevOf = useMemo(() => {
    const m = new Map();
    const PL = prevDates ? prevDates.length : 0;
    for (const a of arts) {
      const p = a.prev; const P = Object.fromEntries(KEYS.map(k => [k, 0]));
      if (p) {
        P.views = p.views; P.pdp = p.pdpViews; P.cart = p.cart; P.orders = p.orders; P.revenue = p.revenue; P.spend = p.spend; P.adOrders = p.adOrders; P.has = 1;
        // Выкуп (модель) и прогноз прибыли — по итогам прошлого периода.
        const k0 = coefOf ? coefOf(a.o) : null;
        if (k0 && p.orders > 0) { P.bW = k0.buyout * 100 * p.orders; P.bN = p.orders; }
        if (forecast && prevDates && (p.orders > 0 || p.spend > 0)) {
          const r = forecast(a.o, prevDates.at(-1), p.revenue, p.orders, p.spend);
          if (r) { P.fProfit = r.profit; P.fRev = r.expRev; P.fAny = 1; P.fPay = r.expRev - r.comm - r.logi - r.acq - r.other - (r.ads || 0) - (r.selfCost || 0); P.fQty = r.expQty || 0; }
        }
      }
      const pp = pricePrev ? pricePrev(a.o) : null;
      if (pp) { P.pS = pp[0]; P.cS = pp[1]; P.pN = pp[2]; }
      const x = Fp && Fp.m.get(a.o);
      let D = null;
      if (x) { D = {}; for (const k of KEYS) D[k] = new Float64Array(PL); for (let d = 0; d < PL; d++) finDay(D, x, Fp, d, a.o, prevDates, { shareAt, coefOf }); }
      m.set(a.o, { P, D });
    }
    return m;
  }, [arts, Fp, prevDates, shareAt, coefOf, forecast, pricePrev]);

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
    const PL = prevDates ? prevDates.length : 0;
    const D = {}; for (const k of KEYS) D[k] = new Float64Array(PL);
    for (const o of list) {
      const p = prevOf.get(o); if (!p) continue;
      for (const k of ['views', 'pdp', 'cart', 'orders', 'revenue', 'spend', 'adOrders', 'bW', 'bN', 'fProfit', 'fRev', 'fPay', 'fQty', 'pS', 'cS', 'pN']) P[k] += p.P[k] || 0;
      P.fAny = P.fAny || p.P.fAny || 0;
      has |= p.P.has || 0;
      if (p.D) { addInto(D, p.D); hasFin = 1; }
    }
    if (hasFin) {
      const F2 = bucketSum(D, Array.from({ length: PL }, (_, i) => i), tax);
      for (const k of ['buyQty', 'buyRub', 'profit', 'finAny', 'payout', 'nsSale']) P[k] = F2[k];
    }
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
    // Сегодняшний день неполный — в подсветке не участвует.
    const today = dayjs().format('YYYY-MM-DD');
    for (const x of b) x.partial = x.idx.some(i => dates[i] === today);
    return b; // по порядку: старые слева, свежие справа
  }, [dates, gran]);
  const skip = useMemo(() => buckets.map(b => b.partial), [buckets]);
  const allIdx = useMemo(() => dates.map((_, i) => i), [dates]);
  const bLabel = b => {
    const d = dayjs(b.key);
    if (gran === 'day') return { t: d.format('DD.MM'), s: b.partial ? 'сегодня' : ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][d.day()], we: d.day() === 0 || d.day() === 6 };
    if (gran === 'week') return { t: `${d.format('DD.MM')}–${d.add(6, 'day').format('DD.MM')}`, s: `нед · ${b.idx.length} дн` };
    return { t: d.format('MM.YYYY'), s: `${b.idx.length} дн` };
  };

  // Подсказка с раскладкой прибыли.
  const [tip, setTip] = useState(null);
  const showTip = (e, S, title, key) => {
    if (!S || !S.finAny) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ x: Math.min(window.innerWidth - 360, r.right + 8), y: Math.max(8, Math.min(window.innerHeight - 440, r.top - 120)), S, title, key });
  };
  // Окно раскладки закрывается кликом в любом другом месте.
  useEffect(() => { if (!tip) return undefined; const on = () => setTip(null); document.addEventListener('click', on); return () => document.removeEventListener('click', on); }, [tip]);

  const shownMets = METRICS.filter(m => mets.includes(m.k));
  const fullL = L || 1;

  // Выбранный узел: вкладка (верхний уровень) → подкатегории → артикул.
  const node = tree.byKey.get(sel) || tree.root;
  const pathKeys = []; { let k = node.key; while (k && k !== '__all') { pathKeys.unshift(k); const parent = [...tree.byKey.values()].find(n => n.kids.some(c => c.key === k)); k = parent ? parent.key : null; } }
  const top = pathKeys[0] ? tree.byKey.get(pathKeys[0]) : null;
  const lvl2 = pathKeys[1] ? tree.byKey.get(pathKeys[1]) : null;
  const revOf = list => list.reduce((s0, o) => { const S = perArt.get(o); if (!S) return s0; let v = 0; for (const x of S.revenue) v += x; return s0 + v; }, 0);
  const artsSorted = useMemo(() => [...node.arts].map(o => ({ o, r: revOf([o]) })).sort((x, y) => y.r - x.r).map(x => x.o), [node, perArt]); // eslint-disable-line react-hooks/exhaustive-deps
  // Поиск сузил список до одного артикула — сразу его и показываем.
  const onlyArt = arts.length === 1 ? arts[0].o : '';
  const curArt = onlyArt || (selArt && node.arts.includes(selArt) ? selArt : '');
  const list = curArt ? [curArt] : node.arts;
  const curKey = curArt ? 'a:' + curArt : node.key;
  const a = curArt ? artBy.get(curArt) : null;
  const title = curArt ? curArt : node.key === '__all' ? (mode === 'groups' ? 'Все группы' : 'Все категории') : node.name;

  const T = daysOf(curKey, list);
  const tot = bucketSum(T, allIdx, tax);
  const { P, has, hasFin } = prevSum(list);
  const cells = buckets.map(b => bucketSum(T, b.idx, tax));
  const perDayTot = tot.orders / fullL;
  const tr = list.reduce((s0, o) => s0 + (Number(transit[o]?.q) || 0), 0);
  const ncol = 4 + buckets.length;

  const metricRow = (m, mi, last) => {
    const vals = cells.map(S => m.v(S, { perDay: perDayTot }));
    const hs = heat(vals, m.dir, skip);
    const vTot = m.k === 'transit' ? (tr || null) : m.k === 'cover' ? (tot.stockN && perDayTot > 0 ? tot.stock / perDayTot : null) : m.v(tot, { perDay: perDayTot });
    const prevOk = m.fin ? hasFin : has;
    // Остаток и «хватит на» — состояние на конец периода: остатков прошлого периода страница не загружает.
    const vPrev = !prevOk || ['stock', 'cover', 'transit', 'adCtr', 'selfQ', 'selfR'].includes(m.k) ? null : m.v(P, { perDay: 0 });
    const finMissing = m.fin && !fin;
    return (
      <React.Fragment key={m.k}>
      <tr className={`${m.strong ? 'rnp-strong' : ''} ${last && !(m.k === 'profit' && profOpen) ? 'rnp-last' : ''}`}>
        <td className={`rnp-m ${m.k === 'profit' ? 'rnp-click' : ''}`} onClick={m.k === 'profit' ? () => setProfOpen(v => !v) : undefined}
          title={m.k === 'profit' ? 'Нажмите — раскладка по статьям в ₽ и в %' : m.h || m.t}>{m.k === 'profit' && <span className={`rnp-mini ${profOpen ? 'on' : ''}`}>▶</span>}{m.t}</td>
        <td className="n r rnp-tot">{finMissing ? '…' : fmt(vTot, m.kind)}</td>
        <td className="n r rnp-prev">{m.now || finMissing ? '' : fmt(vPrev, m.kind)}</td>
        <td className="n r rnp-dyn">{m.now || finMissing ? '' : <Delta cur={vTot} prev={vPrev} kind={m.kind} dir={m.dir} />}</td>
        {cells.map((S, i) => (
          <td key={i} className={`n r ${m.tip ? 'rnp-tipc' : ''}`} style={hs[i] ? { background: hs[i] } : undefined}
            onClick={m.tip ? e => { e.stopPropagation(); if (tip && tip.key === m.k + i) setTip(null); else showTip(e, S, `${title} · ${bLabel(buckets[i]).t}`, m.k + i); } : undefined}
            title={m.tip ? 'Нажмите — раскладка прибыли' : undefined}>
            {m.now ? '' : finMissing ? '…' : fmt(vals[i], m.kind)}
          </td>
        ))}
      </tr>
      {m.k === 'profit' && profOpen && profitRows()}
      </React.Fragment>
    );
  };
  // Статьи прибыли (как в подсказке и «P&L»): сначала ₽, затем те же статьи в % от выкупов.
  const PARTS = [
    ['Выкупы (за вычетом возвратов)', S => S.buyRub],
    ['Продажи без артикула (доля)', S => S.nsSale],
    ...OZ.map(k => [OZ_T[k], S => S['oz_' + k]]),
    ['Прочее без артикула (доля)', S => S.nsOther],
    ['Реклама', S => S.ozAds + S.nsAds - S.adLate],
    ['Себестоимость', S => -S.cost],
    ['Налог', S => -S.tax],
  ];
  const profitRows = () => {
    const used = PARTS.filter(([, f]) => Math.abs(f(tot)) >= 0.5 || cells.some(S => Math.abs(f(S)) >= 0.5));
    const row = (key, label, f, kind, cls) => (
      <tr key={key} className={`rnp-sub ${cls || ''}`}>
        <td className="rnp-m">{label}</td>
        <td className="n r rnp-tot">{tot.finAny ? fmt(f(tot), kind) : '—'}</td>
        <td className="n r rnp-prev" /><td className="n r rnp-dyn" />
        {cells.map((S, i) => <td key={i} className="n r">{S.finAny ? fmt(f(S), kind) : '—'}</td>)}
      </tr>
    );
    const pctOf = f => S => (S.buyRub ? f(S) / S.buyRub * 100 : null);
    return (
      <>
        {used.map(([t, f], i) => row('r' + i, t, f, 'rub'))}
        <tr className="rnp-sub rnp-subh"><td className="rnp-m">в % от выкупов</td><td colSpan={3 + cells.length} /></tr>
        {used.filter(([t]) => !t.startsWith('Выкупы')).map(([t, f], i) => row('p' + i, t, pctOf(f), 'pct', i === used.length - 2 ? 'rnp-last' : ''))}
      </>
    );
  };

  const TT = tip?.S;
  const tipRows = TT ? [
    ['Выкупы (за вычетом возвратов)', TT.buyRub, true],
    ['Продажи без артикула (доля)', TT.nsSale],
    ...OZ.map(k => [OZ_T[k], TT['oz_' + k]]),
    ['Прочее без артикула (доля)', TT.nsOther],
    ['Реклама', TT.ozAds + TT.nsAds - TT.adLate],
    ['Себестоимость', -TT.cost],
    ['Налог', -TT.tax],
  ].filter(r => r[2] || Math.abs(r[1]) >= 0.5) : [];

  const allOpen = SECTIONS.every(g => secOpen[g]), noneOpen = SECTIONS.every(g => !secOpen[g]);
  const tabs = [...tree.root.kids].map(n => ({ n, r: revOf(n.arts) })).sort((x, y) => (y.n.name === 'Чехлы') - (x.n.name === 'Чехлы') || y.r - x.r).map(x => x.n);
  const tabCnt = n => n.arts.length;
  return (
    <div className="rnp">
      <div className="a-bar" style={{ gap: 8, flexWrap: 'wrap', margin: '10px 0 6px' }}>
        <span className="a-seg">{[['cats', 'Категории'], ['groups', 'Группы «Рекламы»']].map(([k, t]) => <button key={k} type="button" className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{t}</button>)}</span>
        <span className="a-seg">{[['day', 'Дни'], ['week', 'Недели'], ['month', 'Месяцы']].map(([k, t]) => <button key={k} type="button" className={gran === k ? 'on' : ''} onClick={() => setGran(k)}>{t}</button>)}</span>
        <span className="a-seg" title="Кратко — в каждом разделе только главные строки; Подробно — все">
          <button type="button" className={noneOpen ? 'on' : ''} onClick={() => setSecOpen({})}>Кратко</button>
          <button type="button" className={allOpen ? 'on' : ''} onClick={() => setSecOpen(Object.fromEntries(SECTIONS.map(g => [g, true])))}>Подробно</button>
        </span>
        <span className="tb-tplwrap" ref={pickRef}>
          <button type="button" className="a-btn" onClick={() => setPick(p => !p)}>Строки · {shownMets.length} ▾</button>
          {pick && (
            <div className="tb-tplpop rnp-pick">
              {SECTIONS.map(g => (
                <div key={g} className="rnp-pg">
                  <div className="rnp-pgt">{g}</div>
                  {METRICS.filter(m => m.g === g).map(m => (
                    <label key={m.k} className="tb-chk" style={{ display: 'flex', padding: '2px 0' }}>
                      <input type="checkbox" checked={mets.includes(m.k)} onChange={e => setMets(x => (e.target.checked ? METRICS.map(y => y.k).filter(k => x.includes(k) || k === m.k) : x.filter(k => k !== m.k)))} /><span style={{ flex: 1 }}>{m.t}</span>
                      <button type="button" className={`rnp-star ${keysOn.has(m.k) ? 'on' : ''}`} title={keysOn.has(m.k) ? 'Видна в кратком виде — нажмите, чтобы убрать' : 'Показывать и в кратком виде'}
                        onClick={e => { e.preventDefault(); e.stopPropagation(); setKeyList(x => (x.includes(m.k) ? x.filter(k => k !== m.k) : [...x, m.k])); }}>★</button>
                    </label>
                  ))}
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button type="button" className="a-btn ghost" onClick={() => { setMets(METRICS.filter(m => !m.off).map(m => m.k)); setKeyList(METRICS.filter(m => m.key).map(m => m.k)); }}>по умолчанию</button>
                <span className="a-hint" style={{ margin: 0 }}>★ — строка видна и в кратком виде</span>
                <button type="button" className="a-btn ghost" onClick={() => setMets(METRICS.map(m => m.k))}>все</button>
              </div>
            </div>
          )}
        </span>
        <span className="a-hint" style={{ margin: 0 }}>ячейки: зеленее — лучше, краснее — хуже · наведите на прибыль — раскладка{!fin ? ' · начисления Ozon загружаются…' : ''}</span>
      </div>
      {!onlyArt && (
        <div className="rnp-nav">
          <div className="a-tabs">
            <button type="button" className={`a-tab ${node.key === '__all' ? 'on' : ''}`} onClick={() => { setSel('__all'); setSelArt(''); }}>Все<span className="c">{arts.length}</span></button>
            {tabs.map(n => <button key={n.key} type="button" className={`a-tab ${top && top.key === n.key ? 'on' : ''}`} onClick={() => { setSel(n.key); setSelArt(''); }}>{n.name}<span className="c">{tabCnt(n)}</span></button>)}
          </div>
          <div className="rnp-subs">
            {top && top.kids.length > 0 && (
              <select className="a-sel" value={lvl2 ? lvl2.key : ''} onChange={e => { setSel(e.target.value || top.key); setSelArt(''); }} title="Подкатегория">
                <option value="">Все: {top.name}</option>
                {top.kids.map(k => <option key={k.key} value={k.key}>{k.name} · {k.arts.length}</option>)}
              </select>
            )}
            {lvl2 && lvl2.kids.length > 0 && (
              <select className="a-sel" value={pathKeys[2] || ''} onChange={e => { setSel(e.target.value || lvl2.key); setSelArt(''); }} title="Подкатегория">
                <option value="">Все: {lvl2.name}</option>
                {lvl2.kids.map(k => <option key={k.key} value={k.key}>{k.name} · {k.arts.length}</option>)}
              </select>
            )}
            <select className="a-sel" value={curArt} onChange={e => setSelArt(e.target.value)} title="Один артикул — по убыванию заказов, ₽">
              <option value="">Все артикулы · {node.arts.length}</option>
              {artsSorted.map(o => <option key={o} value={o}>{o}{artBy.get(o)?.short ? ` · ${artBy.get(o).short}` : ''}</option>)}
            </select>
          </div>
        </div>
      )}
      <div className="rnp-title">
        <b>{title}</b>
        <span>{curArt ? (a?.n || a?.short || '') : `${list.length} арт.`}{curArt && a?.cat ? ` · ${a.cat}` : ''}</span>
        {curArt && !onlyArt && <button type="button" className="a-btn ghost" onClick={() => setSelArt('')}>← ко всем артикулам</button>}
      </div>
      <div className="a-card rnp-card">
        <div className="a-scroll rnp-scroll" ref={scrollRef}>
          <table className="a-t rnp-t no-sh rnp-one">
            <thead><tr>
              <th className="rnp-m l">Метрика</th>
              <th className="r rnp-tot">Итого</th>
              <th className="r rnp-prev" title="Такой же по длине период перед выбранным">Пред. период</th>
              <th className="r rnp-dyn">Динамика</th>
              {buckets.map(b => { const l = bLabel(b); return <th key={b.key} className={`r rnp-d ${l.we ? 'we' : ''} ${b.partial ? 'part' : ''}`} title={b.partial ? 'Сегодня — день ещё идёт, в подсветке не участвует' : undefined}><div>{l.t}</div><small>{l.s}</small></th>; })}
            </tr></thead>
            {SECTIONS.map(g => {
              const all = shownMets.filter(m => m.g === g);
              if (!all.length) return null;
              const opened = !!secOpen[g];
              const rows = opened ? all : all.filter(m => keysOn.has(m.k));
              const hidden = all.length - rows.length;
              return (
                <tbody key={g} className="rnp-sec">
                  <tr className="rnp-sech"><td colSpan={ncol}>
                    <button type="button" className="rnp-secb" onClick={() => setSecOpen(x => ({ ...x, [g]: !x[g] }))}>
                      <span className={`rnp-chev ${opened ? 'on' : ''}`}>▶</span>{g}
                      {!opened && hidden > 0 && <small>ещё {hidden}</small>}
                    </button>
                  </td></tr>
                  {rows.map((m, i) => metricRow(m, i, i === rows.length - 1))}
                </tbody>
              );
            })}
          </table>
        </div>
      </div>
      {tip && TT && (
        <div className="rnp-tip" style={{ left: tip.x, top: tip.y }}>
          <div className="rnp-tipt">Прибыль · {tip.title}</div>
          {tipRows.map(([t, v, head]) => (
            <div key={t} className={`rnp-tr ${head ? 'h' : ''}`}><span>{t}</span><b>{fmtInt(v)} ₽</b><i>{TT.buyRub ? fmtPct((v / TT.buyRub) * 100) : ''}</i></div>
          ))}
          <div className="rnp-tr tot"><span>Прибыль</span><b className={TT.profit < 0 ? 's-down' : 's-up'}>{fmtInt(TT.profit)} ₽</b><i>{TT.buyRub ? fmtPct((TT.profit / TT.buyRub) * 100) : ''}</i></div>
          <div className="rnp-tipn">% — от выкупов. Как в «P&L»: начисления Ozon дня; реклама за дни, которые Ozon ещё не провёл, — из кабинета.</div>
        </div>
      )}
    </div>
  );
}
