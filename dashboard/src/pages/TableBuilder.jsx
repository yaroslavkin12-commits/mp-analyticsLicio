import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import { getSalesData, getFinancePnl, getSewing, saveSewing } from '../api';
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
  { g: 'Заказы и трафик', k: 'avgCheck', t: 'Средний чек заказа', kind: 'rub' },
  { g: 'Заказы и трафик', k: 'views', t: 'Показы', kind: 'int' },
  { g: 'Заказы и трафик', k: 'pdp', t: 'Переходы в карточку', kind: 'int' },
  { g: 'Заказы и трафик', k: 'cart', t: 'В корзину', kind: 'int' },
  { g: 'Заказы и трафик', k: 'crOrder', t: 'Конверсия в заказ', kind: 'pct' },
  { g: 'Заказы и трафик', k: 'position', t: 'Средняя позиция', kind: 'num' },
  { g: 'Реклама', k: 'spend', t: 'Расход на рекламу', kind: 'rub' },
  { g: 'Реклама', k: 'drr', t: 'ДРР', kind: 'pct' },
  { g: 'Реклама', k: 'adOrders', t: 'Заказы с рекламы', kind: 'int' },
  { g: 'Остатки', k: 'stock', t: 'Остаток', kind: 'int', noDays: true },
  { g: 'Остатки', k: 'cover', t: 'Запаса хватит, дней', kind: 'int' },
  { g: 'Остатки', k: 'sewing', t: 'В пути (отшивается)', kind: 'int', noDays: true, now: true },
  { g: 'Финансы (начисления Ozon)', k: 'buyQty', t: 'Выкупы, шт', kind: 'int', fin: true },
  { g: 'Финансы (начисления Ozon)', k: 'buyRub', t: 'Выкупы, ₽', kind: 'rub', fin: true },
  { g: 'Финансы (начисления Ozon)', k: 'payout', t: 'Поступление на счёт', kind: 'rub', fin: true },
  { g: 'Финансы (начисления Ozon)', k: 'payUnit', t: 'Поступление на 1 выкуп', kind: 'rub', fin: true },
  { g: 'Финансы (начисления Ozon)', k: 'cost', t: 'Себестоимость выкупов', kind: 'rub', fin: true },
  { g: 'Финансы (начисления Ozon)', k: 'profit', t: 'Чистая прибыль', kind: 'rub', fin: true },
  { g: 'Финансы (начисления Ozon)', k: 'profitUnit', t: 'Прибыль на 1 выкуп', kind: 'rub', fin: true },
  { g: 'Финансы (начисления Ozon)', k: 'margin', t: 'Маржинальность', kind: 'pct', fin: true },
  { g: 'Финансы (начисления Ozon)', k: 'roi', t: 'ROI', kind: 'pct', fin: true },
];
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
  let t = m.t;
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
    case 'crOrder': { const r = div(S.orders, S.pdp); return r === null ? null : r * 100; }
    case 'drr': { const r = div(S.spend, S.revenue); return r === null ? null : r * 100; }
    case 'position': return div(S.posSum, S.posCnt);
    case 'cover': { const pd = D ? S.orders / D : 0; return pd > 0 ? S.stock / pd : (S.stock > 0 ? null : 0); }
    case 'payUnit': return div(S.payout, S.buyQty);
    case 'profitUnit': return div(S.profit, S.buyQty);
    case 'margin': { const r = div(S.profit, S.buyRub); return r === null ? null : r * 100; }
    case 'roi': { const r = div(S.profit, S.cost); return r === null ? null : r * 100; }
    default: return S[k] ?? null;
  }
}
const BASE_KEYS = ['orders', 'revenue', 'views', 'pdp', 'cart', 'spend', 'adOrders', 'posSum', 'posCnt', 'stock', 'sewing', 'buyQty', 'buyRub', 'payout', 'cost', 'profit'];

let idSeq = Date.now();
const newId = () => 'c' + (idSeq++).toString(36);

export default function TableBuilder({ cabinet, anchor, scope, prepare, tax, shareOf, onOpenArticle }) {
  const storeKey = `mp-builder:${cabinet}`;
  const [cfg, setCfg] = useState(() => { const s = load(storeKey); return s?.cols?.length ? { rows: s.rows || 'art', cols: s.cols } : DEFAULT; });
  const [templates, setTemplates] = useState(() => load(storeKey + ':tpl') || {});
  const [edit, setEdit] = useState(null); // id столбца в редакторе
  const [hideEmpty, setHideEmpty] = useState(() => load(storeKey + ':empty') !== false);
  useEffect(() => { save(storeKey + ':empty', hideEmpty); }, [storeKey, hideEmpty]);
  // Своя категория конструктора (хлебные крошки): «Все / Чехлы / Чехлы на сиденья».
  const [catPath, setCatPath] = useState(() => load(storeKey + ':cat') || '');
  useEffect(() => { save(storeKey + ':cat', catPath); }, [storeKey, catPath]);
  const [drag, setDrag] = useState(null); // id перетаскиваемого столбца
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
  useEffect(() => { save(storeKey + ':tpl', templates); }, [storeKey, templates]);

  // Сколько дней истории нужно под все столбцы.
  const span = useMemo(() => Math.min(MAX_SPAN, Math.max(1, ...cfg.cols.map(c => (MET[c.m]?.noDays ? 1 : c.days) * (c.cmp ? 2 : 1) + (c.off || 0)))), [cfg.cols]);
  const needFin = cfg.cols.some(c => MET[c.m]?.fin);
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
    }
    S.stock = a.stockArr[hi] ?? 0;
    S.sewing = isSeat(a) ? (sewLc.get(String(a.o).toLowerCase()) || 0) : 0;
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
      S.profit = pay - cost - s * (shareOf ? shareOf(a.o) : 1) * (tax || 0) / 100;
    }
    return S;
  }, [finArt, shareOf, tax, sewLc]);

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
    const colsSpec = cfg.cols.map(c => {
      const m = MET[c.m]; const D = m?.noDays ? 1 : c.days;
      const hi = L - 1 - (c.off || 0), lo = hi - D + 1;
      return { c, m, D, lo, hi, plo: lo - D, phi: lo - 1, partial: lo < 0 || (m?.fin && finArt?.mn && data.dates[Math.max(0, lo)] < finArt.mn) };
    });
    const calc = list => colsSpec.map(({ c, m, D, lo, hi, plo, phi }) => {
      if (!m) return { v: null };
      const add = (lo2, hi2) => {
        const T = Object.fromEntries(BASE_KEYS.map(k => [k, 0]));
        for (const a of list) { const S = sumsOf(a, lo2, hi2, D); for (const k of BASE_KEYS) T[k] += S[k]; }
        return derive(c.m, T, D);
      };
      const v = add(lo, hi);
      const p = c.cmp && !m.noDays ? (plo >= 0 ? add(plo, phi) : null) : undefined;
      return { v, p };
    });
    const rows = [...groups.entries()].map(([key, list]) => {
      const a = cfg.rows === 'art' ? list[0] : null;
      const name = a ? a.o : (cfg.rows === 'cat' || cfg.rows === 'sub') && catPath && key.startsWith(catPath + SEP) ? key.slice(catPath.length + SEP.length) : key === catPath && cfg.rows === 'cat' ? `${key.split(SEP).pop()} (без подкатегории)` : key;
      return { key, a, list, name, cat: a ? a.cat : '', sub: a ? a.short : `${list.length} арт.`, vals: calc(list) };
    });
    return { rows, total: { key: '__t', name: 'Итого', sub: `${inScope.length} арт.`, vals: calc(inScope) }, colsSpec };
  }, [L, cfg, inScope, sumsOf, finArt, data, depth, catPath]);

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

  // Шаблон — всё, что видно: строки, столбцы, категория, «скрыть пустые»,
  // сортировка и фильтры столбцов.
  const snap = () => ({ rows: cfg.rows, cols: cfg.cols, catPath, hideEmpty, sort: ctl.sort || null, filters: ctl.filters || {} });
  const [activeTpl, setActiveTpl] = useState(null);
  const tplDirty = activeTpl && templates[activeTpl]
    ? JSON.stringify({ rows: cfg.rows, cols: cfg.cols, catPath }) !== JSON.stringify({ rows: templates[activeTpl].rows, cols: templates[activeTpl].cols, catPath: templates[activeTpl].catPath ?? catPath })
    : true;
  const saveTpl = () => {
    const name = window.prompt('Название шаблона (то же название — перезаписать)', activeTpl || '');
    if (!name || !name.trim()) return;
    const k = name.trim();
    setTemplates(t => ({ ...t, [k]: snap() }));
    setActiveTpl(k);
  };
  const applyTpl = name => {
    const t = templates[name]; if (!t) return;
    setCfg({ rows: t.rows || 'art', cols: (t.cols || []).map(c => ({ ...c })) });
    if (t.catPath !== undefined) setCatPath(t.catPath || '');
    if (t.hideEmpty !== undefined) setHideEmpty(!!t.hideEmpty);
    ctl.reset();
    if (t.sort) ctl.setSort(t.sort);
    for (const [k, f] of Object.entries(t.filters || {})) ctl.setFilter(k, f);
    setEdit(null);
    setActiveTpl(name);
  };
  const delTpl = name => { setTemplates(t => { const n = { ...t }; delete n[name]; return n; }); if (activeTpl === name) setActiveTpl(null); };
  // Сортировка и фильтры по столбцу, которого больше нет, не должны прятать всю таблицу.
  useEffect(() => {
    const ok = new Set(['__name', '__cat', ...cfg.cols.map(c => c.id)]);
    for (const k of Object.keys(ctl.filters || {})) if (!ok.has(k)) ctl.setFilter(k, null);
    if (ctl.sort && !ok.has(ctl.sort.k)) ctl.setSort(null);
  }, [cfg.cols]); // eslint-disable-line react-hooks/exhaustive-deps

  const csv = () => {
    const head = [ROW_MODES.find(r => r[0] === cfg.rows)[1], ...cfg.cols.flatMap(c => (c.cmp && !MET[c.m]?.noDays ? [colTitle(c), colTitle(c) + ' (пред.)'] : [colTitle(c)]))];
    const num = v => (v === null || v === undefined || !Number.isFinite(v) ? '' : String(Math.round(v * 100) / 100).replace('.', ','));
    const lines = [head, ...[table.total, ...shown].map(r => [r.name + (r.cat ? ` (${r.cat})` : ''), ...r.vals.flatMap((x, i) => (cfg.cols[i].cmp && !MET[cfg.cols[i].m]?.noDays ? [num(x.v), num(x.p)] : [num(x.v)]))])];
    const text = '﻿' + lines.map(l => l.map(s => `"${String(s).replace(/"/g, '""')}"`).join(';')).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const el = document.createElement('a'); el.href = url; el.download = `таблица-${anchor}.csv`; el.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const ed = cfg.cols.find(c => c.id === edit);
  const LIMIT = 300;

  const cell = (x, i) => {
    const m = MET[cfg.cols[i].m];
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
          {Object.keys(templates).length > 0 && (
            <select className="a-input tb-sel" value={activeTpl && !tplDirty ? activeTpl : ''} onChange={e => e.target.value && applyTpl(e.target.value)} title="Открыть сохранённый шаблон">
              <option value="">{activeTpl && tplDirty ? `${activeTpl} (изменён)` : 'Шаблоны…'}</option>
              {Object.keys(templates).map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
          <button type="button" className="a-btn ghost" onClick={saveTpl} title="Запомнить текущие строки и столбцы под именем">Сохранить шаблон</button>
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
      <div className="tb-bar">
        <span className="tb-lbl">Столбцы</span>
        {cfg.cols.map(c => (
          <button key={c.id} type="button" {...dnd(c.id)} title="Нажмите — изменить; перетащите — поменять местами"
            className={`tb-chip ${edit === c.id ? 'on' : ''} ${drag === c.id ? 'drag' : ''} ${over === c.id && drag && drag !== c.id ? 'over' : ''}`} onClick={() => setEdit(e => (e === c.id ? null : c.id))}>
            {colTitle(c)}{c.cmp && !MET[c.m]?.noDays ? ' · Δ' : ''}
          </button>
        ))}
        <button type="button" className="tb-chip add" onClick={addCol}>+ столбец</button>
      </div>

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

      {ed && (
        <div className="tb-ed">
          <label>Метрика
            <select className="a-input" value={ed.m} onChange={e => setCol(ed.id, { m: e.target.value })}>
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
          {Object.keys(templates).length > 0 && (
            <span className="tb-tpls">Шаблоны: {Object.keys(templates).map(n => <span key={n} className="tb-tpl">{n}<span onClick={() => delTpl(n)} title="Удалить шаблон">×</span></span>)}</span>
          )}
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
                <ThCtl ctl={ctl} k="__name" className="" filter={false}>{ROW_MODES.find(r => r[0] === cfg.rows)[1]}</ThCtl>
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
                {shown.slice(0, LIMIT).map(r => (
                  <tr key={r.key} className="row" onClick={() => openRow(r)} title={r.a ? 'Открыть артикул в дереве выше' : cfg.rows !== 'brand' ? 'Показать, что внутри' : ''}>
                    <td><div className="a-art"><div style={{ minWidth: 0 }}><div className="id">{r.name}{!r.a && cfg.rows !== 'brand' ? ' ›' : ''}</div><div className="model" title={r.a?.n || ''}>{r.sub}</div></div></div></td>
                    {cfg.rows === 'art' && <td className="muted tb-cat" title={r.cat}>{(catPath && r.cat.startsWith(catPath + SEP) ? r.cat.slice(catPath.length + SEP.length) : r.cat.split(SEP).slice(-2).join(SEP)) || '—'}</td>}
                    {r.vals.map((x, i) => <td key={cfg.cols[i].id} className="n r">{cell(x, i)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length > LIMIT && <div className="a-hint">Показаны первые {LIMIT} из {shown.length} — уточните фильтр или скачайте CSV.</div>}
          </div>
        )}
    </div>
  );
}
