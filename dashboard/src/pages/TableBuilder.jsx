import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import { getSalesData, getFinancePnl } from '../api';
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
  if (c.off) t += ` · ${perTxt(c.off, c.unit)} назад`;
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
const BASE_KEYS = ['orders', 'revenue', 'views', 'pdp', 'cart', 'spend', 'adOrders', 'posSum', 'posCnt', 'stock', 'buyQty', 'buyRub', 'payout', 'cost', 'profit'];

let idSeq = Date.now();
const newId = () => 'c' + (idSeq++).toString(36);

export default function TableBuilder({ cabinet, anchor, scope, prepare, tax, shareOf, onOpenArticle, onOpenCat }) {
  const storeKey = `mp-builder:${cabinet}`;
  const [cfg, setCfg] = useState(() => { const s = load(storeKey); return s?.cols?.length ? { rows: s.rows || 'art', cols: s.cols } : DEFAULT; });
  const [templates, setTemplates] = useState(() => load(storeKey + ':tpl') || {});
  const [edit, setEdit] = useState(null); // id столбца в редакторе
  const [hideEmpty, setHideEmpty] = useState(() => load(storeKey + ':empty') !== false);
  useEffect(() => { save(storeKey + ':empty', hideEmpty); }, [storeKey, hideEmpty]);
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
    for (const [d0, b, a] of fin.noSku || []) {
      const d = pd[d0]; if (d === undefined) continue;
      const k = fin.buckets[b];
      if (k === 'ads') nsAds[d] += a; else if (OZ.includes(k)) nsOther[d] += a;
    }
    return { m, saleDay, adDay, nsOther, nsAds, mn: fin.available?.mn || null };
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
    const x = finArt?.m.get(a.o);
    if (finArt && x) {
      let s = 0, q = 0, oz = 0, ad = 0, saleW = 0, adW = 0, nsA = 0;
      for (let d = l; d <= hi; d++) { s += x.s[d]; q += x.q[d]; oz += x.oz[d]; ad += x.ad[d]; saleW += finArt.saleDay[d]; adW += finArt.adDay[d]; nsA += finArt.nsAds[d]; }
      const shareW = saleW ? s / saleW : 0;
      // Прочее без артикула — по выручке дня (как в P&L), реклама без артикула — по расходу кабинета.
      let other = 0;
      for (let d = l; d <= hi; d++) other += finArt.nsOther[d] * (finArt.saleDay[d] > 0 ? x.s[d] / finArt.saleDay[d] : shareW);
      const pay = s + oz + other + nsA * (adW > 0 ? ad / adW : shareW);
      const cost = (x.cost || 0) * Math.max(0, q);
      S.buyQty = q; S.buyRub = s; S.payout = pay; S.cost = cost;
      S.profit = pay - cost - s * (shareOf ? shareOf(a.o) : 1) * (tax || 0) / 100;
    }
    return S;
  }, [finArt, shareOf, tax]);

  const inScope = useMemo(() => arts.filter(a => !scope || scope.has(a.o)), [arts, scope]);

  // Значения: строки → [ { v, prev } по каждому столбцу ].
  const table = useMemo(() => {
    if (!L) return { rows: [], total: null };
    const groupOf = a => (cfg.rows === 'art' ? a.o : cfg.rows === 'cat' ? a.parts[0] : cfg.rows === 'sub' ? a.cat : (a.brand || 'Не определена'));
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
      return { key, a, list, name: a ? a.o : key, sub: a ? a.short : `${list.length} арт.`, vals: calc(list) };
    });
    return { rows, total: { key: '__t', name: 'Итого', sub: `${inScope.length} арт.`, vals: calc(inScope) }, colsSpec };
  }, [L, cfg, inScope, sumsOf, finArt, data]);

  const ctl = useTableCtl(`builder-${cabinet}`);
  // «Пустые» строки — все значения нулевые или пустые (обычно артикулы без движения).
  const rowsIn = useMemo(() => (hideEmpty ? table.rows.filter(r => r.vals.some(x => (x.v && Number.isFinite(x.v)) || (x.p && Number.isFinite(x.p)))) : table.rows), [table.rows, hideEmpty]);
  const shown = useMemo(() => ctl.apply(rowsIn, (r, k) => {
    if (k === '__name') return r.name;
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

  const saveTpl = () => {
    const name = window.prompt('Название шаблона', '');
    if (!name) return;
    setTemplates(t => ({ ...t, [name.trim()]: { rows: cfg.rows, cols: cfg.cols } }));
  };
  const applyTpl = name => { const t = templates[name]; if (t) { setCfg({ rows: t.rows, cols: t.cols.map(c => ({ ...c })) }); setEdit(null); } };
  const delTpl = name => setTemplates(t => { const n = { ...t }; delete n[name]; return n; });

  const csv = () => {
    const head = [ROW_MODES.find(r => r[0] === cfg.rows)[1], ...cfg.cols.flatMap(c => (c.cmp && !MET[c.m]?.noDays ? [colTitle(c), colTitle(c) + ' (пред.)'] : [colTitle(c)]))];
    const num = v => (v === null || v === undefined || !Number.isFinite(v) ? '' : String(Math.round(v * 100) / 100).replace('.', ','));
    const lines = [head, ...[table.total, ...shown].map(r => [r.name, ...r.vals.flatMap((x, i) => (cfg.cols[i].cmp && !MET[cfg.cols[i].m]?.noDays ? [num(x.v), num(x.p)] : [num(x.v)]))])];
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
            <select className="a-input tb-sel" value="" onChange={e => e.target.value && applyTpl(e.target.value)} title="Сохранённые шаблоны">
              <option value="">Шаблоны…</option>
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
        <span className="tb-lbl">Столбцы</span>
        {cfg.cols.map(c => (
          <button key={c.id} type="button" className={`tb-chip ${edit === c.id ? 'on' : ''}`} onClick={() => setEdit(e => (e === c.id ? null : c.id))}>
            {colTitle(c)}{c.cmp && !MET[c.m]?.noDays ? ' · Δ' : ''}
          </button>
        ))}
        <button type="button" className="tb-chip add" onClick={addCol}>+ столбец</button>
      </div>

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
          <label>{MET[ed.m]?.noDays ? 'На дату' : 'Сдвиг назад'}
            <span className="tb-pair">
              <input className="a-input" type="number" min="0" value={ed.unit === 'w' ? (ed.off || 0) / 7 : ed.off || 0}
                onChange={e => { const n = Math.max(0, Math.round(Number(e.target.value) || 0)); setCol(ed.id, { off: Math.min(MAX_SPAN - 1, ed.unit === 'w' ? n * 7 : n) }); }} />
              <span className="tb-u">{ed.unit === 'w' ? 'нед' : 'дн'} {MET[ed.m]?.noDays ? 'назад' : ''}</span>
            </span>
          </label>
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
                {cfg.cols.map((c, i) => (
                  <ThCtl key={c.id} ctl={ctl} k={c.id} unit={MET[c.m]?.kind === 'pct' ? '%' : MET[c.m]?.kind === 'rub' ? '₽' : ''}>
                    {colTitle(c)}{table.colsSpec?.[i]?.partial ? '*' : ''}
                  </ThCtl>
                ))}
              </tr></thead>
              <tbody>
                {table.total && (
                  <tr className="tb-total">
                    <td><b>Итого</b> <span className="muted" style={{ fontSize: 11.5 }}>{table.total.sub}</span></td>
                    {table.total.vals.map((x, i) => <td key={cfg.cols[i].id} className="n r">{cell(x, i)}</td>)}
                  </tr>
                )}
                {!shown.length && <tr><td colSpan={cfg.cols.length + 1} className="muted" style={{ padding: 12 }}>Ничего не подходит под фильтр</td></tr>}
                {shown.slice(0, LIMIT).map(r => (
                  <tr key={r.key} className="row" onClick={() => (r.a ? onOpenArticle?.(r.a.o) : cfg.rows !== 'brand' ? onOpenCat?.(r.key) : null)}>
                    <td><div className="a-art"><div style={{ minWidth: 0 }}><div className="id">{r.name}</div><div className="model" title={r.a?.n || ''}>{r.sub}</div></div></div></td>
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
