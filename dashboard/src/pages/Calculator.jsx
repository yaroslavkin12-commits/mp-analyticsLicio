import CategoryNav from '../components/CategoryNav';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { getCalcBase, getFinanceCoefs } from '../api';
import { unitCoefs } from './unitModel';
import { fmtInt, naturalCompare, shortModel, CAT_COLORS } from './AdsStats2';
import { pct1 } from './finShared';
import { useBuyerShare } from './buyerShare';
import { useTaxSettings } from '../lib/taxSettings';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// Калькулятор юнит-экономики Ozon (по образцу unit.truestats.ru, но база —
// наша собственная, собирается сама из данных кабинета за 30 дней):
//   • комиссия FBO/FBS — из карточек товаров (у категории — медиана);
//   • % выкупа — по статусам заказов; СПП — по замерам Соинвеста;
//   • логистика — тарифы Ozon из карточек (прямой поток + последняя миля,
//     обратный поток), для нового товара — по похожим по объёму товарам;
//   • эквайринг, хранение и прочие услуги — доля от выкупов по финансам;
//   • реклама (ДРР) — расход / заказы.
// Логистика на 1 продажу: при выкупе B% на одну продажу приходится 100/B
// поездок — прямая логистика за каждую и обратная за каждую невыкупленную.
// Любое поле можно поменять руками; ↺ возвращает значение из базы.
// ─────────────────────────────────────────────────────────────────────────

const SEP = ' / ';
const n0 = v => { const x = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(x) ? x : 0; };
const rub = v => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : `${fmtInt(v)} ₽`;
const median = arr => { const a = arr.filter(v => v !== null && Number.isFinite(v)).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const r1 = v => (v === null || !Number.isFinite(v)) ? null : Math.round(v * 10) / 10;
const HIST_KEY = 'mp-calc-history';
// Время от заказа до отгрузки FBS → поправка к комиссии из карточки, п.п.
const SHIP = [['fact', 'как сейчас (факт за 30 дней)', 0], ['12', 'до 12 часов', -3], ['24', '12–24 часа', -2], ['36', '24–36 часов', 0], ['48', '36–48 часов', 1], ['72', 'больше 48 часов', 2]];

// Суммы по набору артикулов → коэффициенты «базы».
export function baseOf(rows, scheme) {
  if (!rows.length) return null;
  let sale = 0, saleQty = 0, comm = 0, logi = 0, acq = 0, so = 0, ord = 0, del = 0, can = 0, ads = 0, rev = 0, q30 = 0, sppW = 0, sppV = 0, ads7 = 0, rev7 = 0;
  for (const x of rows) {
    sale += x[17]; saleQty += x[18]; comm += x[19]; logi += x[20]; acq += x[21]; so += x[22]; ord += x[13]; del += x[15]; can += x[16];
    // Реклама — из рекламного кабинета (оплата за заказ — на дату заказа); у старых ответов — из начислений.
    ads += x[37] !== undefined ? x[37] : x[23]; rev += x[24]; q30 += x[25]; ads7 += x[38] || 0; rev7 += x[39] || 0;
    if (x[11] !== null) { const w = x[24] || 1; sppW += w; sppV += x[11] * w; }
  }
  const fbs = scheme === 'fbs';
  // Логистика — по фактическим списаниям: прямая (с последней милей и
  // обработкой) на одну отправку и обратная на один возврат. Тарифы из
  // карточки Ozon — это максимум по всем кластерам, они сильно завышены.
  let dSum = 0, dTrips = 0, rSum = 0, rTrips = 0, cFbs = 0, sFbs = 0, cFbo = 0, sFbo = 0;
  for (const x of rows) { dSum += x[30] || 0; dTrips += x[31] || 0; rSum += x[32] || 0; rTrips += x[33] || 0; cFbo += x[26] || 0; sFbo += x[27] || 0; cFbs += x[28] || 0; sFbs += x[29] || 0; }
  const bo = del + can >= 10 ? del / (del + can) : null;
  let direct = dTrips >= 3 && dSum < 0 ? -dSum / dTrips : null;
  let ret = rTrips >= 2 && rSum < 0 ? -rSum / rTrips : null;
  if (direct === null && saleQty >= 3 && logi < 0) {
    // Старые данные без числа отправок: логистика на продажу F = d·t + r·(t−1), r ≈ d, t = 1/выкуп.
    const t = 1 / (bo || 0.8);
    direct = -logi / saleQty / (2 * t - 1);
  }
  if (ret === null && direct !== null) ret = direct;
  const factFbs = sFbs > 0 && cFbs < 0 ? -cFbs / sFbs * 100 : null;
  const factFbo = sFbo > 0 && cFbo < 0 ? -cFbo / sFbo * 100 : null;
  return {
    n: rows.length,
    price: median(rows.map(x => x[1])),
    avgCheck: q30 > 0 ? rev / q30 : null,
    commission: median(rows.map(x => (fbs ? x[3] : x[2]))),
    commCard: median(rows.map(x => (fbs ? x[3] : x[2]))),
    commFact: fbs ? factFbs : factFbo,
    buyout: del + can >= 10 ? del / (del + can) * 100 : null,
    spp: sppW ? sppV / sppW : null,
    direct, ret, trips: dTrips,
    logiFact: ord >= 5 && logi < 0 ? -logi / ord : null, // ₽ на заказанную штуку (факт)
    acquiring: sale > 0 && saleQty >= 3 ? Math.max(0, -acq / sale * 100) : null,
    other: sale > 0 && saleQty >= 3 ? Math.max(0, -so / sale * 100) : null,
    // ДРР прогнозный = реклама / (заказы × % выкупа): сколько реклама стоит с каждой будущей продажи.
    // drrOrd — от суммы заказов (без выкупа); страница делит его на выкуп, выбранный для товара.
    drrOrd: rev > 0 ? Math.max(0, ads / rev * 100) : null,
    drrOrd7: rev7 > 0 ? Math.max(0, ads7 / rev7 * 100) : null,
    drr: rev > 0 ? Math.min(100, Math.max(0, ads / rev * 100) / (bo || 0.8)) : null,
    volume: median(rows.map(x => x[4])),
    cost: median(rows.map(x => x[12])),
    fbsShare: ord > 0 ? rows.reduce((s, x) => s + x[14], 0) / ord * 100 : null,
    orders: q30,
  };
}

const FIELDS = [
  // key, label, suffix, источник в базе
  ['price', 'Цена реализации (до скидки Ozon)', '₽'],
  ['spp', 'Скидка для покупателя (СПП), налог — от цены после неё', '%'],
  ['cost', 'Себестоимость', '₽'],
  ['buyout', 'Процент выкупа', '%'],
  ['defect', 'Процент брака', '%'],
  ['commission', 'Комиссия Ozon', '%'],
  ['acquiring', 'Эквайринг', '%'],
  ['direct', 'Логистика за отправку (с доставкой до ПВЗ и обработкой)', '₽'],
  ['ret', 'Обратная логистика за невыкуп', '₽'],
  ['other', 'Хранение и прочие услуги', '%'],
  ['drr', 'Реклама (ДРР)', '%'],
  ['oper', 'Операционные расходы на 1 шт', '₽'],
  ['tax', 'Ставка налога', '%'],
];
// ДРР прогнозный для товара: от суммы заказов, делённый на выкуп (в %), не больше 100.
export const drrPred = (b, buyoutPct, key = 'drrOrd') => (b && b[key] !== null && b[key] !== undefined && buyoutPct > 0 ? Math.min(100, b[key] / (buyoutPct / 100)) : null);
export const DEFAULTS = { spp: 20, buyout: 80, defect: 0, commission: 20, acquiring: 1.5, direct: 80, ret: 60, other: 1, drr: 5, oper: 0, tax: 6, cost: 0 };

export function compute(v, price, taxMode) {
  const P = price;
  const b = Math.max(1, Math.min(100, v.buyout));
  const trips = 100 / b;
  const commission = P * v.commission / 100;
  const acquiring = P * v.acquiring / 100;
  const logDirect = v.direct * trips;
  const logReturn = v.ret * (trips - 1);
  const other = P * v.other / 100;
  const ads = P * v.drr / 100;
  const mp = commission + acquiring + logDirect + logReturn + other + ads;
  const cost = v.cost, defect = v.cost * v.defect / 100, oper = v.oper;
  // База налога — цена, которую платит покупатель (после скидки Ozon / «Баллов за скидки»), письмо ФНС от 02.09.2026 № СД-35-3/11693@.
  const income = P * (1 - (v.spp || 0) / 100);
  const base = taxMode === 'usn_profit' ? Math.max(0, income - mp - cost - defect - oper) : income;
  const tax = base * v.tax / 100;
  const outside = cost + defect + tax + oper;
  const profit = P - mp - outside;
  return { P, buyerPrice: P * (1 - v.spp / 100), trips, commission, acquiring, logDirect, logReturn, logistics: logDirect + logReturn, other, ads, mp,
    cost, defect, tax, taxBase: base, oper, outside, profit, margin: P > 0 ? profit / P * 100 : null, roi: cost > 0 ? profit / cost * 100 : null, payout: P - mp };
}
// Цена, при которой маржа = target (0 — безубыточность). Прибыль растёт с ценой — ищем делением пополам.
export function priceFor(v, taxMode, target) {
  let lo = 1, hi = 1e6;
  const f = p => { const r = compute(v, p, taxMode); return r.profit - p * target / 100; };
  if (f(hi) < 0) return null;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (f(mid) >= 0) hi = mid; else lo = mid; }
  return hi;
}

function Num({ label, value, suffix, onChange, auto, src, onReset }) {
  const edited = auto !== undefined && auto !== null && Math.abs(n0(value) - r1(auto)) > 1e-9;
  return (
    <label className="k-field">
      <span className="k-lbl">{label}</span>
      <span className="k-inp">
        <input value={value} inputMode="decimal" onChange={e => onChange(e.target.value)} className={edited ? 'edited' : ''} />
        <i>{suffix}</i>
      </span>
      <span className="k-src">
        {src}
        {edited && <button type="button" className="k-reset" title="Вернуть значение из базы" onClick={onReset}>↺ {suffix === '₽' ? fmtInt(auto) : r1(auto)}</button>}
      </span>
    </label>
  );
}

function Row({ label, value, sub, strong, neg, hint }) {
  return (
    <div className={`k-row ${sub ? 'sub' : ''} ${strong ? 'strong' : ''}`} title={hint}>
      <span>{label}</span><b className={`n ${neg ? 'neg' : ''}`}>{value}</b>
    </div>
  );
}

export default function Calculator({ cabinet }) {
  const taxSettings = useTaxSettings(cabinet);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [scheme, setScheme] = useState('fbo');
  const [ship, setShip] = useState('fact');
  const [cat, setCat] = useState('');
  const [art, setArt] = useState(null);
  const [q, setQ] = useState('');
  const [dims, setDims] = useState({ l: '', w: '', h: '', liters: '' });
  const [dimMode, setDimMode] = useState('dims');
  const [vals, setVals] = useState({});
  const [taxMode, setTaxMode] = useState('usn_income');
  const [budget, setBudget] = useState('');
  const [tab, setTab] = useState('calc');
  const [name, setName] = useState('');
  const [hist, setHist] = useState(() => { try { return JSON.parse(localStorage.getItem(HIST_KEY + cabinet) || '[]'); } catch (e) { return []; } });

  useEffect(() => {
    setData(null); setError(null);
    getCalcBase(cabinet).then(r => setData(r.data.data)).catch(e => setError(e.response?.data?.error || e.message));
  }, [cabinet]);

  const arts = useMemo(() => (data?.articles || []).map((a, i) => ({ ...a, i, short: shortModel(a.n) || a.n })), [data]);
  const rowsByArt = useMemo(() => new Map((data?.a || []).map(x => [x[0], x])), [data]);
  const bsArts = useMemo(() => arts.map(a => ({ o: a.o, parts: String(a.cat || '').split(SEP) })), [arts]);
  const bs = useBuyerShare(cabinet, bsArts);
  // Единая модель прибыли (как в «Юнит-экономике», «Рекламе», «Цены и маржа») — для выбранного товара.
  const [coefs, setCoefs] = useState(null);
  useEffect(() => { setCoefs(null); getFinanceCoefs(cabinet).then(r => setCoefs(r.data.data)).catch(() => setCoefs(false)); }, [cabinet]);
  const K = useMemo(() => {
    if (!coefs) return null;
    const ks = unitCoefs(coefs, bsArts, bs.shareOf);
    return new Map(bsArts.map((a, i) => [a.o, ks[i]]));
  }, [coefs, bsArts, bs.shareOf]);
  const rank = useMemo(() => new Map((data?.order || []).map((x, i) => [x, i])), [data]);
  const leafCats = useMemo(() => {
    const m = new Map();
    for (const a of arts) if (rowsByArt.has(a.i)) m.set(a.cat, (m.get(a.cat) || 0) + 1);
    const key = p => p.split(SEP).map(x => (rank.has(x) ? String(rank.get(x)).padStart(4, '0') : '9999') + x).join('|');
    return [...m.entries()].sort((x, y) => naturalCompare(key(x[0]), key(y[0])));
  }, [arts, rowsByArt, rank]);
  const tops = useMemo(() => [...new Set(leafCats.map(([c]) => c.split(SEP)[0]))], [leafCats]);

  const volume = dimMode === 'liters' ? n0(dims.liters) : n0(dims.l) * n0(dims.w) * n0(dims.h) / 1000;

  // База: артикул → категория → весь кабинет; логистика — ещё и по объёму.
  const base = useMemo(() => {
    if (!data) return null;
    const all = data.a;
    const inCat = cat ? all.filter(x => { const c = arts[x[0]]?.cat || ''; return c === cat || c.startsWith(cat + SEP); }) : all;
    const own = art !== null ? rowsByArt.get(art) : null;
    const bCat = baseOf(inCat, scheme), bAll = baseOf(all, scheme), bOwn = own ? baseOf([own], scheme) : null;
    // Логистика по объёму: товары с похожим объёмом (±35%) — сначала в категории, затем во всём кабинете.
    let bVol = null, volN = 0;
    if (volume > 0 && !own) {
      const near = list => list.filter(x => x[4] && Math.abs(x[4] - volume) / volume <= 0.35);
      let list = near(inCat); if (list.length < 3) list = near(all);
      if (list.length) { bVol = baseOf(list, scheme); volN = list.length; }
    }
    const pick = (key, srcs) => { for (const [b, label] of srcs) if (b && b[key] !== null && b[key] !== undefined) return [b[key], label]; return [DEFAULTS[key] ?? null, 'по умолчанию']; };
    const catLabel = cat ? `категория, ${bCat?.n || 0} арт.` : `кабинет, ${bAll?.n || 0} арт.`;
    const S = [[bOwn, 'из карточки товара'], [bCat, catLabel], [bAll, 'весь кабинет']];
    const SF = [[bOwn, 'факт товара за 30 дн'], [bCat, `факт ${catLabel}`], [bAll, 'факт кабинета']];
    const SL = [[bOwn, 'факт товара: списания / отправки'], [bVol, `факт похожих по объёму (${volN} арт.)`], [bCat, `факт, ${catLabel}`], [bAll, 'факт кабинета']];
    // Комиссия: FBO — из карточки (одна ставка). FBS — зависит от скорости
    // отгрузки: по отчёту Ozon у одного товара бывает 44, 45 или 47%. По
    // умолчанию берём фактическую среднюю FBS за 30 дней, можно выбрать время.
    const commOf = () => {
      if (scheme === 'fbs' && ship === 'fact') {
        const f = pick('commFact', [[bOwn, 'факт FBS товара за 30 дн'], [bCat, `факт FBS, ${catLabel}`], [bAll, 'факт FBS кабинета']]);
        if (f[0] !== null && f[0] !== undefined) return f;
      }
      const c = pick('commCard', S);
      const adj = scheme === 'fbs' ? (SHIP.find(x => x[0] === ship)?.[2] || 0) : 0;
      return [c[0] + adj, c[1] + (adj ? ` ${adj > 0 ? '+' : '−'}${Math.abs(adj)} п.п. за время отгрузки` : '')];
    };
    const out = {
      price: own && own[36] && own[1] ? [own[1], `цена в кабинете (проверена ${own[36].slice(8, 10)}.${own[36].slice(5, 7)})`] : pick('price', S), spp: pick('spp', S), cost: pick('cost', S), buyout: pick('buyout', SF),
      commission: commOf(), acquiring: pick('acquiring', SF), direct: pick('direct', SL), ret: pick('ret', SL),
      other: pick('other', SF),
      // Реклама: у выбранного товара — только его собственный ДРР (не рекламировался — 0);
      // средний по категории — лишь для нового товара.
      drr: pick('drr', SF), defect: [0, ''], oper: [0, ''], tax: [taxSettings.enabled ? taxSettings.rate : 0, 'Товары → Налог'],
    };
    // Выбранный товар — коэффициенты единой модели: так расчёт совпадает с «Цены и маржа» и «Юнит-экономикой».
    const k = own ? K?.get(arts[own[0]]?.o) : null;
    if (k) {
      const SRC = { own: 'товара', cat: 'категории', all: 'кабинета', def: 'по умолчанию' };
      const lbl = (src, what) => `${what} ${SRC[src] || ''}`.trim();
      out.buyout = [Math.round(k.buyout * 1000) / 10, lbl(k.src.buyout, 'выкуп за 90 дн (без последней недели),')];
      if (ship === 'fact') out.commission = [Math.round((scheme === 'fbs' ? k.commFbs : k.commFbo) * 1000) / 10, scheme === 'fbs' ? 'факт FBS (единая модель)' : 'из карточки (единая модель)'];
      out.acquiring = [Math.round(k.acq * 1000) / 10, lbl(k.src.acq, 'факт за 30 дн,')];
      out.other = [Math.round(k.other * 1000) / 10, 'факт за 30 дн + общие расходы кабинета'];
      if (k.direct !== null && k.direct !== undefined) {
        out.direct = [Math.round(k.direct * 10) / 10, lbl(k.src.logi, 'факт: списания / отправки,')];
        out.ret = [Math.round((k.ret ?? k.direct) * 10) / 10, lbl(k.src.logi, 'факт: списания / возвраты,')];
      }
    }
    // Реклама: у выбранного товара — только его собственный ДРР (не рекламировался — 0);
    // средний по категории — лишь для нового товара. Прогнозный: реклама / (заказы × выкуп).
    if (own) {
      const bo = out.buyout[0];
      const d = drrPred(bOwn, bo), d7 = drrPred(bOwn, bo, 'drrOrd7');
      const r1s = v => String(Math.round(v * 10) / 10).replace('.', ',');
      out.drr = d === null ? [0, 'нет заказов за 30 дн — реклама 0']
        : [Math.round(d * 10) / 10, d > 0 ? `прогноз за 30 дн: реклама / (заказы × выкуп ${r1s(bo)}%)${d7 !== null ? ` · за 7 дн ${r1s(d7)}%` : ''}` : 'товар не рекламировался'];
    }
    // Скидка для покупателя (СПП): прежде всего — текущая, с сайта (расширение
    // «Соинвест»: цена с Ozon-картой к цене в кабинете). Отчёт «Начисления»
    // (баллы за скидки) — только запасной вариант: он за прошлый месяц и при
    // другой цене, а СПП Ozon меняет постоянно.
    if (own && own[11] !== null && own[11] !== undefined) {
      const d = own[36] ? own[36].slice(8, 10) + '.' + own[36].slice(5, 7) : '';
      out.spp = [own[11], `с сайта${d ? ` (${d})` : ''}${own[34] ? `: с Ozon-картой ${Math.round(own[34]).toLocaleString('ru-RU')} ₽` : ''}${own[35] ? `, без карты ${Math.round(own[35]).toLocaleString('ru-RU')} ₽` : ''}`];
    } else if ((out.spp[0] === null || out.spp[0] === undefined || out.spp[1] === 'весь кабинет') && bs.shareOf) {
      const sh = own ? bs.shareOf(arts[own[0]]?.o, String(arts[own[0]]?.cat || '').split(SEP)) : bs.shareOf('', cat ? cat.split(SEP) : []);
      if (sh) out.spp = [Math.round((1 - sh) * 1000) / 10, 'по отчёту «Начисления» за прошлый период (баллы за скидки)'];
    }
    if (own && (own[12] === null)) out.cost = [null, 'нет себестоимости — заполните во вкладке «Себестоимость»'];
    return { out, bCat, bOwn, bAll };
  }, [data, cat, art, scheme, volume, arts, rowsByArt, ship, bs.shareOf, K, taxSettings.enabled, taxSettings.rate]);

  const auto = k => base?.out[k]?.[0];
  const valRaw = k => (vals[k] !== undefined ? vals[k] : (auto(k) !== null && auto(k) !== undefined ? String(r1(auto(k)) ?? '') : ''));
  // Цена клиента (после СПП): если её ввели вручную — цена реализации считается из неё
  // при текущей СПП (репрайсер держит именно цену клиента).
  const val = k => {
    if (k === 'tax' && !taxSettings.enabled) return '0';
    if (k === 'price' && vals.client !== undefined && vals.client !== '') {
      const c = n0(vals.client), sp = n0(valRaw('spp'));
      if (c > 0 && sp < 100) return String(Math.round(c / (1 - sp / 100) * 100) / 100);
    }
    return valRaw(k);
  };
  const set = (k, v) => setVals(p => { const x = { ...p, [k]: v }; if (k === 'price') delete x.client; return x; });
  const reset = k => setVals(p => { const x = { ...p }; delete x[k]; if (k === 'price') delete x.client; return x; });
  const V = {};
  for (const [k] of FIELDS) V[k] = n0(val(k));
  const priceIn = val('price');
  const res = n0(priceIn) > 0 ? compute(V, n0(priceIn), taxMode) : null;
  const be = res ? priceFor(V, taxMode, 0) : null;

  const pickArt = a => {
    setArt(a.i); setCat(a.cat); setQ(''); setVals({}); setName(`${a.o} · ${a.short}`);
    const x = rowsByArt.get(a.i);
    if (x?.[4]) { setDimMode('liters'); setDims(d => ({ ...d, liters: String(x[4]) })); }
    if (x && x[13] > 0 && x[14] / x[13] > 0.5) setScheme('fbs');
  };
  const found = q.trim().length >= 2 ? arts.filter(a => rowsByArt.has(a.i) && (String(a.o || '').toLowerCase().includes(q.trim().toLowerCase()) || (a.n || '').toLowerCase().includes(q.trim().toLowerCase()))).slice(0, 12) : [];

  const saveHist = () => {
    if (!res) return;
    const item = { id: Date.now(), name: name || (cat ? cat.split(SEP).slice(-1)[0] : 'Расчёт'), at: new Date().toISOString(), scheme, cat, art, vals: Object.fromEntries(FIELDS.map(([k]) => [k, val(k)])), taxMode, dims, dimMode, profit: res.profit, margin: res.margin, roi: res.roi, price: res.P };
    const next = [item, ...hist].slice(0, 100);
    setHist(next); try { localStorage.setItem(HIST_KEY + cabinet, JSON.stringify(next)); } catch (e) { /* ignore */ }
  };
  const loadHist = h => { setScheme(h.scheme); setCat(h.cat || ''); setArt(h.art ?? null); setVals(h.vals || {}); setTaxMode(h.taxMode || 'usn_income'); setDims(h.dims || { l: '', w: '', h: '', liters: '' }); setDimMode(h.dimMode || 'dims'); setName(h.name); setTab('calc'); };
  const delHist = id => { const next = hist.filter(h => h.id !== id); setHist(next); try { localStorage.setItem(HIST_KEY + cabinet, JSON.stringify(next)); } catch (e) { /* ignore */ } };
  const resetAll = () => { setArt(null); setCat(''); setVals({}); setDims({ l: '', w: '', h: '', liters: '' }); setName(''); setBudget(''); };

  const clientField = () => {
    const P = n0(val('price')), sp = n0(val('spp'));
    const shown = vals.client !== undefined ? vals.client : (P > 0 ? String(Math.round(P * (1 - sp / 100))) : '');
    const base0 = n0(valRaw('price')); // цена реализации без учёта введённой цены клиента
    const autoC = base0 > 0 ? Math.round(base0 * (1 - sp / 100)) : null;
    return <Num key="client" label="Цена клиента (после СПП) — меняет цену реализации" suffix="₽" value={shown} onChange={v => set('client', v)} auto={autoC}
      src={vals.client !== undefined && vals.client !== '' ? `цена реализации ${fmtInt(n0(val('price')))} ₽ при СПП ${r1(sp)}%` : 'цена реализации × (1 − СПП)'} onReset={() => reset('client')} />;
  };
  const field = k => {
    const f = FIELDS.find(x => x[0] === k);
    return <Num key={k} label={f[1]} suffix={f[2]} value={val(k)} onChange={v => set(k, v)} auto={auto(k)} src={base?.out[k]?.[1]} onReset={() => reset(k)} />;
  };
  const qty = res && n0(budget) > 0 && V.cost > 0 ? Math.floor(n0(budget) / V.cost) : null;

  if (error) return <div className="mpui"><div className="a-empty" style={{ padding: 40 }}>Не удалось загрузить базу: {error}</div></div>;

  return (
    <div className="mpui sa-page">
      <div className="page-sticky">
        <div className="a-top">
          <h1>Калькулятор юнит-экономики</h1>
          <span className="a-seg">{[['calc', 'Калькулятор'], ['base', 'База по категориям'], ['hist', `История (${hist.length})`]].map(([k, l]) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</span>
          {!data && <span className="a-hint">загружаем базу…</span>}
        </div>
      </div>

      {tab === 'base' && data && <BaseTable data={data} arts={arts} leafCats={leafCats} tops={tops} scheme={scheme} setScheme={setScheme}
        onPick={c => { setCat(c); setArt(null); setVals({}); setName(c.split(SEP).slice(-1)[0]); setTab('calc'); }} />}

      {tab === 'hist' && (
        <div className="a-card">
          <table className="a-t s-slice">
            <thead><tr><th>Расчёт</th><th>Схема</th><th className="r">Цена реализации</th><th className="r">Прибыль</th><th className="r">Маржа</th><th className="r">ROI</th><th>Когда</th><th /></tr></thead>
            <tbody>
              {hist.map(h => (
                <tr key={h.id} className="row" style={{ cursor: 'pointer' }} onClick={() => loadHist(h)}>
                  <td><b>{h.name}</b><div className="muted" style={{ fontSize: 11.5 }}>{h.cat}</div></td><td>{h.scheme.toUpperCase()}</td>
                  <td className="n r">{rub(h.price)}</td><td className={`n r ${h.profit < 0 ? 's-down' : ''}`}>{rub(h.profit)}</td><td className="n r">{pct1(h.margin)}</td><td className="n r">{pct1(h.roi)}</td>
                  <td className="muted">{new Date(h.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                  <td><button type="button" className="a-btn ghost" onClick={e => { e.stopPropagation(); delHist(h.id); }}>×</button></td>
                </tr>
              ))}
              {!hist.length && <tr><td colSpan={8} className="muted" style={{ padding: 16 }}>Сохранённых расчётов пока нет — кнопка «Сохранить» в калькуляторе.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'calc' && (
        <div className="k-grid">
          <div className="k-col">
            <div className="a-card k-card">
              <div className="k-head">
                <b>Товар</b>
                <span className="a-seg">{[['fbo', 'FBO'], ['fbs', 'FBS']].map(([k, l]) => <button key={k} type="button" className={scheme === k ? 'on' : ''} onClick={() => setScheme(k)}>{l}</button>)}</span>
                <button type="button" className="a-btn ghost" style={{ marginLeft: 'auto' }} onClick={resetAll}>Сбросить</button>
              </div>
              <label className="k-field wide">
                <span className="k-lbl">Взять товар из кабинета — все поля заполнятся его данными</span>
                <span className="k-inp"><input value={q} onChange={e => setQ(e.target.value)} placeholder="Артикул или название" /></span>
                {found.length > 0 && (
                  <div className="k-drop">
                    {found.map(a => <button key={a.i} type="button" onClick={() => pickArt(a)}><b>{a.o}</b> {a.short}<span className="muted"> · {a.cat}</span></button>)}
                  </div>
                )}
              </label>
              {art !== null && (
                <div className="k-chip">Товар: <b>{arts[art]?.o}</b> {arts[art]?.short} <button type="button" className="a-btn ghost" onClick={() => { setArt(null); setVals({}); }}>× как новый товар категории</button></div>
              )}
              <div className="k-field wide">
                <span className="k-lbl">Категория — средние значения подставятся сами</span>
                <CategoryNav tops={tops} value={cat} onChange={path=>{setCat(path);setArt(null);setVals({});}} allLabel="Все товары кабинета" childrenOf={path=>[...new Set(leafCats.filter(([c])=>c.startsWith(path+SEP)).map(([c])=>c.split(SEP)[path.split(SEP).length]).filter(Boolean))]} />
              </div>
              <label className="k-field wide">
                <span className="k-lbl">Название расчёта</span>
                <span className="k-inp"><input value={name} onChange={e => setName(e.target.value)} placeholder="Например: чехлы экокожа, новая модель" /></span>
              </label>
              <div className="k-two">{field('price')}{clientField()}{field('spp')}{field('cost')}{field('buyout')}{field('defect')}</div>
              {res && <div className="k-note">Цена клиента ≈ <b>{rub(res.buyerPrice)}</b> · отправок на 1 продажу <b>{res.trips.toFixed(2).replace('.', ',')}</b> (100 / выкуп) · к перечислению от Ozon <b>{rub(res.payout)}</b></div>}
            </div>

            <div className="a-card k-card">
              <div className="k-head"><b>Габариты</b>
                <span className="a-seg">{[['dims', 'Д × Ш × В'], ['liters', 'Объём, л']].map(([k, l]) => <button key={k} type="button" className={dimMode === k ? 'on' : ''} onClick={() => setDimMode(k)}>{l}</button>)}</span>
              </div>
              <div className="a-hint" style={{ marginBottom: 8 }}>Логистика — по фактическим списаниям Ozon за 30 дней: у товара из кабинета — его собственная, у нового — по вашим товарам похожего объёма (±35%), иначе по категории.</div>
              {dimMode === 'dims' ? (
                <div className="k-three">
                  {[['l', 'Длина'], ['w', 'Ширина'], ['h', 'Высота']].map(([k, l]) => (
                    <label key={k} className="k-field"><span className="k-lbl">{l}</span><span className="k-inp"><input value={dims[k]} inputMode="decimal" onChange={e => setDims(d => ({ ...d, [k]: e.target.value }))} /><i>см</i></span></label>
                  ))}
                </div>
              ) : (
                <label className="k-field"><span className="k-lbl">Объём</span><span className="k-inp"><input value={dims.liters} inputMode="decimal" onChange={e => setDims(d => ({ ...d, liters: e.target.value }))} /><i>л</i></span></label>
              )}
              <div className="a-hint">Итоговый объём: <b>{volume ? `${volume.toFixed(2).replace('.', ',')} л` : '—'}</b></div>
            </div>

            <div className="a-card k-card">
              <div className="k-head"><b>Расходы Ozon</b></div>
              <div className="k-two">
                {field('commission')}
                {scheme === 'fbs' ? (
                  <label className="k-field">
                    <span className="k-lbl">Время отгрузки FBS (влияет на комиссию)</span>
                    <span className="k-inp"><select value={ship} onChange={e => { setShip(e.target.value); reset('commission'); }}>
                      {SHIP.map(([k, l, a]) => <option key={k} value={k}>{l}{k !== 'fact' ? ` (${a > 0 ? '+' : a < 0 ? '−' : '±'}${Math.abs(a)} п.п.)` : ''}</option>)}
                    </select></span>
                    <span className="k-src">от карточки {pct1(base?.bOwn?.commCard ?? base?.bCat?.commCard)}; по отчёту Ozon у FBS бывает 44 / 45 / 47%</span>
                  </label>
                ) : field('acquiring')}
                {scheme === 'fbs' && field('acquiring')}
                {field('direct')}{field('ret')}{field('other')}{field('drr')}
              </div>
            </div>

            <div className="a-card k-card">
              <div className="k-head"><b>Налоги и прочее</b></div>
              <div className="k-two">
                <label className="k-field">
                  <span className="k-lbl">Система налогообложения</span>
                  <span className="k-inp"><select value={taxMode} disabled={!taxSettings.enabled} onChange={e => { setTaxMode(e.target.value); set('tax', e.target.value === 'usn_profit' ? '15' : String(taxSettings.rate)); }}>
                    <option value="usn_income">УСН «Доходы»</option><option value="usn_profit">УСН «Доходы − расходы»</option>
                  </select></span>
                </label>
                {taxSettings.enabled ? field('tax') : <span className="a-hint">Налог отключён в «Товары → Налог»</span>}{field('oper')}
              </div>
            </div>
          </div>

          <div className="k-col k-side">
            <div className="a-card k-card">
              <div className="k-head"><b>Результат на 1 проданную штуку</b></div>
              {!res ? <div className="a-hint">Укажите цену или выберите товар / категорию.</div> : (
                <>
                  <Row label="Цена реализации" value={rub(res.P)} />
                  <Row label="Цена клиента (после СПП)" value={rub(res.buyerPrice)} hint="СПП оплачивает Ozon — на вашу выручку не влияет" />
                  <Row label="Расходы Ozon" value={rub(-res.mp)} strong neg />
                  <Row sub label={`Комиссия ${pct1(V.commission)}`} value={rub(-res.commission)} neg />
                  <Row sub label={`Эквайринг ${pct1(V.acquiring)}`} value={rub(-res.acquiring)} neg />
                  <Row sub label={`Логистика прямая: ${rub(V.direct)} × ${res.trips.toFixed(2).replace('.', ',')} отправки`} value={rub(-res.logDirect)} neg
                    hint={`Чтобы продать 1 шт при выкупе ${pct1(V.buyout)}, товар в среднем отправляется к покупателю 100 / ${pct1(V.buyout)} = ${res.trips.toFixed(2).replace('.', ',')} раза — каждая отправка оплачивается`} />
                  <Row sub label={`Логистика обратная: ${rub(V.ret)} × ${(res.trips - 1).toFixed(2).replace('.', ',')} возврата`} value={rub(-res.logReturn)} neg
                    hint={`Из ${res.trips.toFixed(2).replace('.', ',')} отправок одна выкуплена, остальные ${(res.trips - 1).toFixed(2).replace('.', ',')} — невыкупы, и за каждый платится обратная логистика. То же самое на 1 заказ: обратная × (1 − выкуп) = ${rub(V.ret)} × ${(1 - V.buyout / 100).toFixed(2).replace('.', ',')}; на 1 продажу это делится на выкуп`} />
                  <Row sub label={`Хранение и прочее ${pct1(V.other)}`} value={rub(-res.other)} neg />
                  <Row sub label={`Реклама ${pct1(V.drr)}`} value={rub(-res.ads)} neg />
                  <Row label="Средняя сумма поступления на счёт" value={rub(res.payout)} strong hint="Цена реализации минус все расходы Ozon (комиссия, эквайринг, логистика с учётом невыкупов, хранение, реклама) — столько в среднем приходит на расчётный счёт с 1 проданной штуки" />
                  <Row label="Расходы вне Ozon" value={rub(-res.outside)} strong neg />
                  <Row sub label="Себестоимость" value={rub(-res.cost)} neg />
                  <Row sub label="Брак" value={rub(-res.defect)} neg />
                  <Row sub label={taxMode === 'usn_profit' ? 'Налоговая база (доходы − расходы)' : 'Оплачено покупателем (налоговая база)'} value={rub(res.taxBase)} hint="Налог считается от суммы, которую заплатил покупатель, — цены после скидки Ozon (письмо ФНС от 02.09.2026 № СД-35-3/11693@)" />
                  <Row sub label={`Налог ${pct1(V.tax)}`} value={rub(-res.tax)} neg />
                  <Row sub label="Операционные" value={rub(-res.oper)} neg />
                  <div className={`k-profit ${res.profit < 0 ? 'bad' : ''}`}><span>Чистая прибыль</span><b className="n">{rub(res.profit)}</b></div>
                  <div className="k-mr"><div><span>Маржа</span><b className="n">{pct1(res.margin)}</b></div><div><span>ROI</span><b className="n">{pct1(res.roi)}</b></div></div>
                  <button type="button" className="a-btn primary" style={{ width: '100%', marginTop: 10 }} onClick={saveHist}>Сохранить расчёт</button>
                </>
              )}
            </div>

            {res && (
              <div className="a-card k-card">
                <div className="k-head"><b>Прогнозная цена</b></div>
                <table className="a-t s-slice">
                  <thead><tr><th>Цель</th><th className="r" title="Цена в кабинете (до скидки Ozon)">Цена реализации</th><th className="r" title={`Цена для покупателя со скидкой Ozon (СПП ${pct1(V.spp)})`}>Для клиента</th><th className="r">Прибыль</th><th className="r">ROI</th></tr></thead>
                  <tbody>
                    {[0, 10, 20, 30].map(t => { const p = priceFor(V, taxMode, t); const r = p ? compute(V, p, taxMode) : null; return (
                      <tr key={t} className="row" style={{ cursor: p ? 'pointer' : 'default' }} title="Подставить эту цену" onClick={() => p && set('price', String(Math.ceil(p)))}>
                        <td>{t === 0 ? 'Безубыточность' : `Маржа ${t}%`}</td><td className="n r">{rub(p)}</td><td className="n r muted">{rub(r?.buyerPrice)}</td><td className="n r">{rub(r?.profit)}</td><td className="n r">{pct1(r?.roi)}</td>
                      </tr>
                    ); })}
                  </tbody>
                </table>
                {be && <div className="a-hint" style={{ marginTop: 6 }}>Запас до безубыточности: {pct1((res.P - be) / res.P * 100)} от цены. Клик по строке — подставить цену.</div>}
              </div>
            )}

            {res && (
              <div className="a-card k-card">
                <div className="k-head"><b>Расчёт партии</b></div>
                <label className="k-field"><span className="k-lbl">Бюджет на закупку</span><span className="k-inp"><input value={budget} inputMode="decimal" onChange={e => setBudget(e.target.value)} /><i>₽</i></span></label>
                {qty !== null ? (
                  <>
                    <Row label="Количество, шт" value={fmtInt(qty)} />
                    <Row label="Прогнозная выручка" value={rub(qty * res.P)} />
                    <Row label="Расходы Ozon" value={rub(-qty * res.mp)} neg />
                    <Row label="Средняя сумма поступления на счёт" value={rub(res.payout)} strong hint="Цена реализации минус все расходы Ozon (комиссия, эквайринг, логистика с учётом невыкупов, хранение, реклама) — столько в среднем приходит на расчётный счёт с 1 проданной штуки" />
                  <Row label="Расходы вне Ozon" value={rub(-qty * res.outside)} neg />
                    <Row label="Прогнозируемая прибыль" value={rub(qty * res.profit)} strong />
                  </>
                ) : <div className="a-hint">Нужна себестоимость и бюджет.</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// База по категориям — то, из чего калькулятор берёт средние.
function BaseTable({ data, arts, leafCats, tops, scheme, setScheme, onPick }) {
  const rows = useMemo(() => {
    const by = new Map();
    for (const x of data.a) { const c = arts[x[0]]?.cat; if (!c) continue; if (!by.has(c)) by.set(c, []); by.get(c).push(x); }
    return leafCats.map(([c]) => ({ c, b: baseOf(by.get(c) || [], scheme) })).filter(r => r.b);
  }, [data, arts, leafCats, scheme]);
  return (
    <div className="a-card">
      <div className="a-bar" style={{ padding: '12px 14px 4px' }}>
        <b style={{ fontSize: 14 }}>База по категориям</b>
        <span className="a-seg">{[['fbo', 'FBO'], ['fbs', 'FBS']].map(([k, l]) => <button key={k} type="button" className={scheme === k ? 'on' : ''} onClick={() => setScheme(k)}>{l}</button>)}</span>
        <span className="a-hint">собирается сама из данных кабинета за 30 дней ({data.since ? `с ${data.since.slice(8)}.${data.since.slice(5, 7)}` : ''}); клик — посчитать по категории</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="a-t s-slice">
          <thead><tr>
            <th>Категория</th><th className="r">Арт.</th><th className="r">Цена (медиана)</th><th className="r">Комиссия</th><th className="r">Выкуп</th><th className="r">СПП</th>
            <th className="r">Комиссия факт</th><th className="r">Логистика / отправка</th><th className="r">Обратная / возврат</th><th className="r">Логистика / заказ</th><th className="r">Эквайринг</th><th className="r">Хранение и пр.</th><th className="r">ДРР</th><th className="r">Объём, л</th><th className="r">Заказов 30 дн</th>
          </tr></thead>
          <tbody>
            {rows.map(({ c, b }) => {
              const top = c.split(SEP)[0];
              return (
                <tr key={c} className="row" style={{ cursor: 'pointer' }} onClick={() => onPick(c)}>
                  <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><i className="s-dot" style={{ background: CAT_COLORS[tops.indexOf(top)] || 'var(--a-ink3)' }} />{c.split(SEP).join(' › ')}</span></td>
                  <td className="n r">{b.n}</td><td className="n r">{rub(b.price)}</td><td className="n r">{pct1(b.commission)}</td><td className="n r">{pct1(b.buyout)}</td><td className="n r">{pct1(b.spp)}</td>
                  <td className="n r">{pct1(b.commFact)}</td><td className="n r">{rub(b.direct)}</td><td className="n r">{rub(b.ret)}</td><td className="n r">{rub(b.logiFact)}</td><td className="n r">{pct1(b.acquiring)}</td><td className="n r">{pct1(b.other)}</td><td className="n r">{pct1(b.drr)}</td>
                  <td className="n r">{b.volume ? b.volume.toFixed(1).replace('.', ',') : '—'}</td><td className="n r">{fmtInt(b.orders)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
