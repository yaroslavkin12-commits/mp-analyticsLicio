import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import { getPriceLog, getPriceSnap, getPriceHistory, uploadPriceLog, deletePriceLog, markPriceLog, getSalesData, getCalcBase, getPriceRules, setSnapRule } from '../api';
import { useTableCtl, ThCtl, ResetCtl } from '../components/TableTools';
import PriceDynamics from './PriceDynamics';
import { fmtInt } from './AdsStats2';
import { shopOf } from '../lib/cabinets';
import './ads2.css';
import './sales.css';
import './production.css';

// ─────────────────────────────────────────────────────────────────────────
// «Журнал цен» — что меняли в репрайсере и что из этого вышло.
// Раз в неделю (по средам) загружается выгрузка репрайсера: артикул, цена
// клиента сейчас и новая цена (сейчас Ozon, «Дефлай»). Сводка — сколько и как
// поменяли (правила: +3%, +500 ₽, «поставили N ₽»…), разрез по категориям,
// цели и заметки, заказы Ozon за 7 дней до и после, сверка с ценой на сайте.
// ─────────────────────────────────────────────────────────────────────────

const GOALS = [
  ['grow', 'Разогнать продажи'],
  ['catch', 'Догнать по штукам'],
  ['margin', 'Поднять маржу'],
  ['hold', 'Удержать позиции'],
  ['test', 'Тест'],
];
const GOAL = Object.fromEntries(GOALS);
const SEP = ' / ';
const f1 = v => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1).replace('.', ',')}%`);
const rub = v => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${fmtInt(v)} ₽`);
const drub = v => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtInt(Math.abs(v))} ₽`);

const near = (x, y) => Math.abs(x - y) <= 0.5; // репрайсер считает процент до копеек
const fmtPct = p => `${p > 0 ? '+' : '−'}${Math.abs(p).toString().replace('.', ',')}%`;

// Правила изменения недели: как именно меняли цену. Порядок распознавания:
//   1) ровный процент (шаг 0,5%): новая = было × (1 + p%) до копеек (круглая сумма важнее
//      процента, совпавшего с точностью до рубля);
//   2) круглая сумма (кратно 100 ₽), если так же поменяли ещё хотя бы одному;
//   3) «поставили N ₽», если эту же новую цену получили несколько артикулов;
//   4) одиночные круглые суммы — тоже по сумме; остальное — «точечно ↑/↓».
// Группы из одного артикула сливаются в «точечно», чтобы сводка читалась.
// Своё правило (колонка «Правило» в файле, выгрузка из «Набора» или задано в журнале)
// важнее автоматического: такие артикулы — одной группой, как бы ни отличались цены.
const RSRC = { f: 'из файла', s: 'из набора', m: 'задано в журнале' };
function buildRules(changedAll) {
  const out0 = new Map();
  for (const x of changedAll) if (x.rule) out0.set(x.o, { key: `u:${x.rule}`, label: x.rule, sort: 0, kind: 'user', detail: RSRC[x.rsrc] || '' });
  const changed = changedAll.filter(x => !x.rule);
  const pre = changed.map(x => {
    const pct = (x.b / x.a - 1) * 100, p = Math.round(pct * 2) / 2;
    const d = Math.round(x.b - x.a), round = Math.abs(d) >= 100 && Math.abs(x.b - x.a - Math.round(d / 100) * 100) < 1;
    // Процент точно до копеек (формула «цена + 3%») — это процент. Круглая сумма
    // (9 990 → 9 490) — это рубли, даже если случайно похожа на −5%.
    if (p !== 0 && Math.abs(x.b - x.a * (1 + p / 100)) <= 0.05) return { x, pk: `p${p}`, p };
    if (round) return { x, rk: d };
    if (p !== 0 && near(x.b, x.a * (1 + p / 100))) return { x, pk: `p${p}`, p };
    return { x, rk: null };
  });
  const cnt = new Map(), inc = k => cnt.set(k, (cnt.get(k) || 0) + 1);
  for (const v of pre) if (!v.pk) { if (v.rk !== null) inc(`r${v.rk}`); inc(`t${v.x.b}`); }
  const first = pre.map(v => {
    if (v.pk) return { ...v, g: { key: v.pk, label: fmtPct(v.p), sort: v.p * 100, kind: 'pct' } };
    if (v.rk !== null && cnt.get(`r${v.rk}`) >= 2) return { ...v, g: { key: `r${v.rk}`, label: drub(v.rk), sort: v.rk, kind: 'rub' } };
    if (cnt.get(`t${v.x.b}`) >= 2) return { ...v, g: { key: `t${v.x.b}`, label: `поставили ${rub(v.x.b)}`, sort: v.x.b - v.x.a, kind: 'to' } };
    if (v.rk !== null) return { ...v, g: { key: `r${v.rk}`, label: drub(v.rk), sort: v.rk, kind: 'rub' } };
    return { ...v, g: null };
  });
  const n = new Map(); for (const v of first) if (v.g) n.set(v.g.key, (n.get(v.g.key) || 0) + 1);
  const out = out0;
  for (const v of first) {
    let g = v.g;
    if (!g || n.get(g.key) < 2) {
      const up = v.x.b > v.x.a;
      g = { key: up ? 'spot+' : 'spot-', label: up ? 'точечно ↑' : 'точечно ↓', sort: up ? 1e-6 : -1e-6, kind: 'spot', detail: v.rk !== null && v.rk !== undefined ? drub(v.rk) : v.g?.label || `${fmtPct(Math.round((v.x.b / v.x.a - 1) * 1000) / 10)}` };
    }
    out.set(v.x.o, g);
  }
  return out;
}

// Файл репрайсера. Новый формат (лист «Озон»): «Артикул продавца | Название |
// Цена клиента на удержание | Новые цены» — было и стало в одном файле, пустая
// новая цена = без изменений. Старый формат: колонка «Дефлай» (только «стало»).
// Общий файл на все магазины: «Артикул | Defly | Alex | NABauto | Fullgas
// [| Accent]» — по колонке новых цен на магазин (пусто или 0 = без изменений).
// Колонки ищем по названиям; если заголовков нет — по порядку.
const SHOP_COLS = [['defly', /дефлай|defly/i], ['alex', /алекс|alex/i], ['nabauto', /наб|nab/i], ['fullgas', /фулгаз|fullgas|full gas/i], ['accent', /акцент|accent/i]];
const SHOP_ORDER = ['defly', 'alex', 'nabauto', 'fullgas', 'accent'];
function parseMulti(aoa, num) {
  for (let r = 0; r < Math.min(aoa.length, 6); r++) {
    const row = aoa[r].map(c => String(c));
    const cols = {};
    for (const [id, re] of SHOP_COLS) { const i = row.findIndex((c, k) => k > 0 && re.test(c)); if (i > 0) cols[id] = i; }
    if (Object.keys(cols).length >= 2) return collectMulti(aoa, r + 1, cols, num);
  }
  // Без заголовков: артикул и 4+ числовые колонки подряд.
  const sample = aoa.slice(0, 30).filter(x => String(x[0] ?? '').trim());
  const numCols = c => sample.filter(x => num(x[c]) > 0).length >= sample.length * 0.5;
  if (sample.length && [1, 2, 3, 4].every(numCols)) {
    const cols = {}; SHOP_ORDER.forEach((id, k) => { if (k < 4 || numCols(k + 1)) cols[id] = k + 1; });
    return collectMulti(aoa, 0, cols, num);
  }
  return null;
}
function collectMulti(aoa, start, cols, num) {
  const byCab = {};
  for (const id of Object.keys(cols)) byCab[id] = {};
  for (let r = start; r < aoa.length; r++) {
    const o = String(aoa[r][0] ?? '').trim(); if (!o || /^артикул/i.test(o)) continue;
    for (const [id, c] of Object.entries(cols)) { const n = num(aoa[r][c]); if (Number.isFinite(n) && n > 0) byCab[id][o] = n; }
  }
  return { fmt: 'multi', byCab, items: Object.assign({}, ...Object.values(byCab)) };
}

function parsePrices(aoa) {
  const num = v => (typeof v === 'number' ? v : v === '' || v === null || v === undefined ? NaN : Number(String(v).replace(/\s/g, '').replace(',', '.')));
  const multi = parseMulti(aoa, num);
  if (multi) return multi;
  for (let r = 0; r < Math.min(aoa.length, 6); r++) {
    const row = aoa[r].map(c => String(c).toLowerCase());
    const iNew = row.findIndex(c => /нов/.test(c) && /цен/.test(c));
    const iOld = row.findIndex((c, i) => i !== iNew && /цен/.test(c) && /(клиент|текущ|удерж|сейчас|был)/.test(c));
    const iArt = Math.max(0, row.findIndex(c => /артикул/.test(c)));
    if (iNew >= 0 && iOld >= 0) {
      // Пустая новая цена и 0 (формула на пустую ячейку в рабочем файле) — цена не меняется.
      // Артикул может встретиться дважды: строка с новой ценой важнее строки без неё.
      const items = {}, old = {}, set = new Set(), onlyNew = {};
      for (let i = r + 1; i < aoa.length; i++) {
        const o = String(aoa[i][iArt] ?? '').trim(); if (!o) continue;
        const a = num(aoa[i][iOld]), b = num(aoa[i][iNew]);
        if (b > 0) onlyNew[o] = b;
        if (!(a > 0)) continue;
        if (b > 0) { old[o] = a; items[o] = b; set.add(o); } else if (!set.has(o)) { old[o] = a; items[o] = a; }
      }
      // Колонка «на удержании» пустая или нули — текущие цены возьмёт сервис (цена на сайте).
      if (!Object.keys(old).length) return { items: onlyNew, fmt: 'one', autoOld: true };
      return { items, old, zero: [], fmt: 'two' };
    }
    // Только «Новая цена» (выгрузка из «Набора для выгрузки») — текущие цены возьмёт сервис.
    if (iNew >= 0 && iOld < 0) {
      const items = {};
      for (let i = r + 1; i < aoa.length; i++) { const o = String(aoa[i][iArt] ?? '').trim(), b = num(aoa[i][iNew]); if (o && b > 0) items[o] = b; }
      if (Object.keys(items).length) return { items, fmt: 'one', autoOld: true };
    }
  }
  let col = 1, start = 0;
  for (let r = 0; r < Math.min(aoa.length, 6); r++) {
    const i = aoa[r].findIndex(c => /дефлай|defly/i.test(String(c)));
    if (i > 0) { col = i; start = r + 1; break; }
  }
  const items = {};
  for (let r = start; r < aoa.length; r++) {
    const o = String(aoa[r][0] ?? '').trim(); if (!o || /^артикул/i.test(o)) continue;
    const n = num(aoa[r][col]);
    if (Number.isFinite(n) && n > 0) items[o] = n;
  }
  return { items, fmt: 'one' };
}
// Колонка «Правило» / «Группа» (необязательная): { артикул: правило }.
function parseRuleCol(aoa) {
  for (let r = 0; r < Math.min(aoa.length, 6); r++) {
    const row = (aoa[r] || []).map(c => String(c).trim());
    const iR = row.findIndex(c => /^(правило|группа)/i.test(c));
    if (iR < 0) continue;
    const iA = Math.max(0, row.findIndex(c => /артикул/i.test(c)));
    const out = {};
    for (let i = r + 1; i < aoa.length; i++) {
      const o = String(aoa[i][iA] ?? '').trim(), v = String(aoa[i][iR] ?? '').replace(/\s+/g, ' ').trim();
      if (o && v) out[o] = v.slice(0, 60);
    }
    return out;
  }
  return {};
}
const pickKeys = (m, keys) => { const o = {}; for (const k of Object.keys(keys)) if (m[k]) o[k] = m[k]; return o; };

// Дата из имени файла: «… 14.10.xlsx», «14.10.2026», «2026-10-14».
function dateFromName(name, fallbackYear) {
  let m = name.match(/(20\d\d)-(\d\d)-(\d\d)/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = name.match(/(?:^|[^\d])(\d{1,2})[._](\d{1,2})(?:[._](\d{2,4}))?(?=[^\d]|$)/);
  if (!m) return null;
  const d = +m[1], mo = +m[2]; if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  let y = m[3] ? +m[3] : fallbackYear; if (y < 100) y += 2000;
  let s = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (!m[3] && dayjs(s).isAfter(dayjs().add(7, 'day'))) s = `${y - 1}${s.slice(4)}`; // «28.12» в январе — прошлый год
  return s;
}
// Лист с Ozon: «Озон»/«Ozon», иначе первый не служебный.
function pickSheet(wb) {
  const names = wb.SheetNames.filter(n => !/^hidden/i.test(n));
  return names.find(n => /озон|ozon/i.test(n)) || names[0];
}

// Вердикт по цели и динамике заказов.
function verdict(dir, goal, before, after, days) {
  if (days < 3) return { t: 'рано оценивать', cls: '' };
  if (!before && !after) return { t: 'нет заказов ни до, ни после', cls: '' };
  const ch = before > 0 ? (after / before - 1) * 100 : after > 0 ? 100 : 0;
  const g = goal || (dir < 0 ? 'grow' : dir > 0 ? 'margin' : 'hold');
  if (g === 'grow' || g === 'catch') {
    if (ch >= 20) return { t: `сработало: продажи ${f1(ch)} — больше не снижать, можно вернуть часть цены`, cls: 'up' };
    if (ch > -10) return { t: `продажи почти не изменились (${f1(ch)}) — снижение не помогло`, cls: 'warn' };
    return { t: `продажи упали (${f1(ch)}) — дело не в цене: карточка, позиции, остатки`, cls: 'dn' };
  }
  if (g === 'margin') {
    if (ch >= -15) return { t: `продажи удержались (${f1(ch)}) — повышение прошло`, cls: 'up' };
    return { t: `продажи упали (${f1(ch)}) — повышение бьёт по спросу, проверить`, cls: 'dn' };
  }
  return { t: `продажи ${f1(ch)}`, cls: ch >= 0 ? 'up' : 'dn' };
}

const MIS = 3; // расхождение с ценой на сайте, %, при котором строка подсвечивается
const lastSeg = c => (c || '').split(SEP).slice(-1)[0] || 'без категории';

export default function PriceLog({ cabinet }) {
  const platform = 'ozon';
  const [log, setLog] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState(null);
  const [sel, setSel] = useState(null); // id недели
  const [snapCache, setSnapCache] = useState({}); // id → снимок целиком
  const [sales, setSales] = useState(null);
  const [site, setSite] = useState(null);
  const [upDate, setUpDate] = useState(() => dayjs().format('YYYY-MM-DD'));
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('log'); // log — журнал, dyn — динамика цен
  const [catOf, setCatOf] = useState(new Map());

  const load = useCallback(() => getPriceLog(cabinet, platform).then(r => { setLog(r.data.data); return r.data.data; }).catch(e => setErr(e.response?.data?.error || e.message)), [cabinet]);
  useEffect(() => { setSnapCache({}); load().then(d => { if (d?.snaps?.length) setSel(s => s || d.snaps[d.snaps.length - 1].id); }); }, [load]);

  const snaps = log?.snaps || [];
  const idx = snaps.findIndex(s => s.id === sel);
  const curMeta = idx >= 0 ? snaps[idx] : null, prevMeta = idx > 0 ? snaps[idx - 1] : null;
  const isLatest = idx >= 0 && idx === snaps.length - 1;
  // Снимки выбранной недели и прошлой подгружаются по требованию.
  useEffect(() => {
    for (const m of [curMeta, prevMeta]) {
      if (!m || snapCache[m.id]) continue;
      getPriceSnap(cabinet, platform, m.id).then(r => setSnapCache(c => ({ ...c, [m.id]: r.data.data }))).catch(e => setMsg({ bad: true, text: 'Снимок не загрузился: ' + e.message }));
    }
  }, [curMeta?.id, prevMeta?.id, curMeta?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = curMeta ? snapCache[curMeta.id] : null;
  const prev = prevMeta ? snapCache[prevMeta.id] : null;
  const two = !!cur?.old; // в файле есть и «было», и «стало»
  const ready = cur && (two || !prevMeta || prev);

  // Заказы Ozon по дням и цены на сайте — для оценки результата и сверки.
  useEffect(() => {
    if (!snaps.length) return;
    const from = dayjs(snaps[0].date).subtract(14, 'day').format('YYYY-MM-DD');
    const to = dayjs().format('YYYY-MM-DD');
    getSalesData(cabinet, { dateFrom: dayjs(to).diff(from, 'day') > 400 ? dayjs(to).subtract(400, 'day').format('YYYY-MM-DD') : from, dateTo: to }).then(r => setSales(r.data.data)).catch(() => {});
  }, [cabinet, snaps[0]?.date]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    getCalcBase(cabinet).then(r => {
      const d = r.data.data, m = new Map();
      for (const x of d.a || []) { const o = d.articles[x[0]]?.o; if (o) m.set(o, { card: x[34] || null, site: x[35] || null, at: x[36] || '' }); }
      setSite(m);
      setCatOf(new Map((d.articles || []).map(a => [a.o, a.cat || ''])));
    }).catch(() => {});
  }, [cabinet]);

  // Заказы по артикулу: артикул → Map(дата → шт); категория артикула.
  const ord = useMemo(() => {
    if (!sales) return null;
    const by = new Map();
    for (const r of sales.rows) {
      const a = sales.articles[r[0]]; if (!a || !r[5]) continue;
      let m = by.get(a.o); if (!m) { m = new Map(); by.set(a.o, m); }
      m.set(sales.dates[r[1]], (m.get(sales.dates[r[1]]) || 0) + r[5]);
    }
    const cat = new Map(sales.articles.map(a => [a.o, a.cat]));
    return { by, cat };
  }, [sales]);
  const sumOrders = (o, from, days) => {
    const m = ord?.by.get(o); if (!m) return 0;
    let s = 0; for (let i = 0; i < days; i++) s += m.get(dayjs(from).add(i, 'day').format('YYYY-MM-DD')) || 0;
    return s;
  };
  const marks = (log?.marks || {})[sel] || {};
  const daysAfter = cur ? Math.max(0, Math.min(7, dayjs().startOf('day').diff(dayjs(cur.date), 'day'))) : 0;

  // Изменения недели: «было» из того же файла, а для старых файлов — из прошлой загрузки.
  const changes = useMemo(() => {
    if (!ready) return [];
    const out = [];
    if (two) {
      const zero = new Set(); // 0 в файле = без изменений (см. parsePrices)
      for (const [o, b] of Object.entries(cur.items)) {
        const a = cur.old[o];
        const pp = prev?.items[o];
        const kind = zero.has(o) ? 'zero' : Math.abs(b - a) < 0.5 ? 'same' : b > a ? 'up' : 'down';
        out.push({ o, a, b: kind === 'zero' ? 0 : b, d: kind === 'zero' ? null : b - a, pct: kind === 'zero' ? null : (b / a - 1) * 100, kind,
          drift: prev?.old && pp && Math.abs(a / pp - 1) > 0.005 ? pp : null });
      }
    } else {
      const all = new Set([...Object.keys(cur.items), ...Object.keys(prev?.items || {})]);
      for (const o of all) {
        const a = prev?.items[o], b = cur.items[o];
        const kind = !prev ? 'first' : a && !b ? 'gone' : !a && b ? 'new' : Math.abs(b - a) < 0.5 ? 'same' : b > a ? 'up' : 'down';
        out.push({ o, a, b, d: a && b ? b - a : null, pct: a && b ? (b / a - 1) * 100 : null, kind });
      }
    }
    for (const x of out) { x.rule = cur.rule?.[x.o] || ''; x.rsrc = cur.ruleSrc?.[x.o] || ''; }
    const rules = buildRules(out.filter(x => x.kind === 'up' || x.kind === 'down'));
    for (const x of out) x.g = rules.get(x.o) || (x.kind === 'zero' ? { key: 'zero', label: 'новая цена 0', sort: -1e9, kind: 'zero' } : null);
    return out;
  }, [cur, prev, two, ready]);

  // Сверка с сайтом (цена с Ozon-картой). Для последней недели — живая цена:
  // проверена после даты загрузки → должна совпасть с «стало»; в день загрузки —
  // с «было» или «стало»; раньше — с «было». Для прошлых недель — цена,
  // запомненная при загрузке, против «было».
  const siteOf = useCallback(x => {
    const live = site?.get(x.o);
    const ref = x.kind === 'zero' ? x.a : x.b;
    if (isLatest && live?.card) {
      const day = (live.at || '').slice(0, 10), d = cur?.date || '';
      const dev = p => (p ? (live.card / p - 1) * 100 : null);
      let off;
      if (day > d) off = dev(ref);
      else if (day === d) { const u = dev(x.a), v = dev(ref); off = u === null ? v : v === null ? u : Math.abs(u) < Math.abs(v) ? u : v; }
      else off = dev(x.a ?? ref);
      return { card: live.card, noCard: live.site, at: day, off };
    }
    const st = cur?.site?.[x.o];
    if (st && x.a) return { card: st, at: cur.date, off: (st / x.a - 1) * 100, stored: true };
    return null;
  }, [site, isLatest, cur]);

  const rows = useMemo(() => changes.map(x => {
    const before = cur ? sumOrders(x.o, dayjs(cur.date).subtract(7, 'day'), 7) : 0;
    const after = cur ? sumOrders(x.o, cur.date, daysAfter) : 0;
    const afterN = daysAfter > 0 ? after * 7 / daysAfter : null; // в пересчёте на 7 дней
    const mk = marks[x.o] || {};
    const st = siteOf(x);
    const cat = ord?.cat.get(x.o) || '';
    return { ...x, before, after, afterN, goal: mk.goal || '', note: mk.note || '', cat, cat1: lastSeg(cat), st, off: st?.off ?? null, mis: st?.off !== null && st?.off !== undefined && Math.abs(st.off) > MIS,
      v: x.kind === 'up' || x.kind === 'down' ? verdict(x.d, mk.goal, before, afterN ?? 0, daysAfter) : null };
  }), [changes, cur, daysAfter, marks, siteOf, ord]); // eslint-disable-line react-hooks/exhaustive-deps
  const cnt = k => rows.filter(x => x.kind === k).length;
  const nMis = rows.filter(r => r.mis).length;
  const nDrift = rows.filter(r => r.drift).length;
  const changed = r => r.kind === 'up' || r.kind === 'down';

  // Свод «как меняли»: по правилам и по категориям.
  const ruleRows = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      if (!r.g) continue;
      const v = m.get(r.g.key) || { ...r.g, n: 0, sa: 0, sb: 0, before: 0, after: 0, cats: new Map(), details: new Map() };
      v.n++; v.sa += r.a || 0; v.sb += r.b || 0; v.before += r.before; v.after += r.after || 0;
      v.cats.set(r.cat1, (v.cats.get(r.cat1) || 0) + 1);
      if (r.g.detail) v.details.set(r.g.detail, (v.details.get(r.g.detail) || 0) + 1);
      m.set(r.g.key, v);
    }
    return [...m.values()].sort((a, b) => (a.kind === 'zero') - (b.kind === 'zero') || (a.kind === 'spot') - (b.kind === 'spot') || b.n - a.n);
  }, [rows]);
  const catRows = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const v = m.get(r.cat1) || { cat: r.cat1, up: 0, down: 0, same: 0, zero: 0, pct: 0, nPct: 0, before: 0, after: 0, rules: new Map() };
      if (r.kind === 'up') v.up++; else if (r.kind === 'down') v.down++; else if (r.kind === 'zero') v.zero++; else v.same++;
      if (changed(r)) { v.pct += r.pct; v.nPct++; v.before += r.before; v.after += r.after || 0; v.rules.set(r.g.label, (v.rules.get(r.g.label) || 0) + 1); }
      m.set(r.cat1, v);
    }
    return [...m.values()].filter(v => v.up + v.down + v.zero > 0).sort((a, b) => (b.up + b.down) - (a.up + a.down));
  }, [rows]);
  const [view, setView] = useState('rules');

  // Таблица.
  const [fKind, setFKind] = useState('changed');
  const [fGroup, setFGroup] = useState('');
  const [fCat, setFCat] = useState('');
  const [fGoal, setFGoal] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(new Set());
  const [ruleList, setRuleList] = useState([]);
  useEffect(() => { getPriceRules(cabinet).then(r => setRuleList(r.data.data || [])).catch(() => {}); }, [cabinet]);
  const [bulkRule, setBulkRule] = useState('');
  const applyRule = (offers, rule) => setSnapRule(cabinet, platform, sel, offers, rule)
    .then(r => { setSnapCache(c => ({ ...c, [sel]: r.data.data })); if (rule) getPriceRules(cabinet).then(x => setRuleList(x.data.data || [])).catch(() => {}); })
    .catch(e => setMsg({ bad: true, text: e.message }));
  const [hist, setHist] = useState(null); // { o, rows }
  useEffect(() => { setPicked(new Set()); setFGroup(''); setFCat(''); }, [sel]);
  const list = rows.filter(r => (fKind === 'all' || (fKind === 'changed' ? changed(r) || r.kind === 'zero' : fKind === 'mis' ? r.mis : fKind === 'drift' ? !!r.drift : r.kind === fKind))
    && (!fGroup || r.g?.key === fGroup) && (!fCat || r.cat1 === fCat) && (!fGoal || (fGoal === '—' ? !r.goal : r.goal === fGoal))
    && (!q || r.o.toLowerCase().includes(q.toLowerCase()) || r.cat.toLowerCase().includes(q.toLowerCase())));
  const ctl = useTableCtl(`pricelog-${cabinet}`, { k: 'pct', dir: 1 });
  const GET = { o: r => r.o, a: r => r.a, b: r => r.b, d: r => r.d, pct: r => r.pct, before: r => r.before, after: r => r.after, goal: r => r.goal, off: r => (r.off === null ? null : Math.abs(r.off)) };
  const shown = ctl.apply(list, (r, k) => (GET[k] ? GET[k](r) : null));
  const [full, setFull] = useState(false);
  const vis = full ? shown : shown.slice(0, 50);
  const pickFilter = (kind, group, cat) => { setFKind(kind); setFGroup(group || ''); setFCat(cat || ''); setTimeout(() => document.getElementById('pl-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30); };

  async function onFiles(e) {
    const files = [...(e.target.files || [])]; e.target.value = '';
    if (!files.length) return;
    setMsg(null);
    try {
      const XLSX = await import('xlsx');
      const year = dayjs(upDate).year();
      const parsed = [];
      for (const f of files) {
        const wb = XLSX.read(await f.arrayBuffer());
        const sh = pickSheet(wb);
        const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sh], { header: 1, raw: true, defval: '' });
        const p = parsePrices(aoa);
        p.rules = parseRuleCol(aoa);
        const n = Object.keys(p.items).length;
        const date = files.length === 1 ? upDate : dateFromName(f.name, year);
        const wbFile = /(^|[^а-я])вб|wb|wildberries/i.test(f.name) || /^(вб|wb)/i.test(sh);
        parsed.push({ f, p, n, date, wbFile, sheet: sh });
      }
      const bad = parsed.filter(x => !x.n || !x.date);
      const ok = parsed.filter(x => x.n && x.date && !x.wbFile);
      const lines = ok.map(x => `• ${dayjs(x.date).format('DD.MM.YYYY')} — ${x.p.fmt === 'multi'
        ? Object.entries(x.p.byCab).filter(([, m]) => Object.keys(m).length).map(([id, m]) => `${shopOf(id)?.label || id}: ${Object.keys(m).length} арт.`).join(', ') + ' (текущие цены — с сайта)'
        : `${x.n} арт.${x.p.fmt === 'two' ? `, изменено ${Object.keys(x.p.items).filter(o => Math.abs(x.p.items[o] - x.p.old[o]) >= 0.5).length + x.p.zero.length}` : x.p.autoOld ? ' (текущие цены — с сайта)' : ' (только новые цены)'}`}${snaps.some(s => s.date === x.date) ? ' — заменит снимок' : ''}`);
      const skipped = [...bad.map(x => `${x.f.name}: ${!x.n ? 'не нашёл цены' : 'нет даты в имени файла'}`), ...parsed.filter(x => x.wbFile).map(x => `${x.f.name}: файл WB, пока ведём только Ozon`)];
      if (!ok.length) { setMsg({ bad: true, text: 'Нечего загружать. ' + skipped.join('; ') }); return; }
      if (!window.confirm(`Загрузить новые цены Ozon:\n${lines.join('\n')}${skipped.length ? `\n\nПропущу:\n${skipped.join('\n')}` : ''}`)) return;
      setBusy(true);
      let last = null, ruled = 0;
      for (const x of ok.sort((a, b) => (a.date < b.date ? -1 : 1))) {
        // Цена на сайте в момент загрузки — только для свежих файлов (для прошлых недель её уже не узнать).
        const fresh = Math.abs(dayjs().diff(dayjs(x.date), 'day')) <= 2;
        const st = {};
        if (fresh && site) for (const o of Object.keys(x.p.items)) { const c = site.get(o)?.card; if (c) st[o] = c; }
        if (x.p.fmt === 'multi') {
          // Общий файл: каждому магазину — своя колонка; «было» сервис берёт из цен на сайте.
          for (const [id, items] of Object.entries(x.p.byCab)) {
            if (!Object.keys(items).length) continue;
            const r = await uploadPriceLog(id, platform, x.date, { items, autoOld: true, rules: pickKeys(x.p.rules, items) }, x.f.name);
            ruled += r.data.data.ruled || 0;
            if (id === cabinet) last = r.data.data.snaps;
          }
          if (!last) last = (await getPriceLog(cabinet, platform)).data.data.snaps;
        } else {
          const body = { items: x.p.items, rules: pickKeys(x.p.rules, x.p.items), ...(x.p.fmt === 'two' ? { old: x.p.old, zero: x.p.zero } : {}), ...(x.p.autoOld ? { autoOld: true } : {}), ...(fresh ? { site: st } : {}) };
          const r = await uploadPriceLog(cabinet, platform, x.date, body, x.f.name);
          ruled += r.data.data.ruled || 0;
          last = r.data.data.snaps;
        }
        setSnapCache(c => { const n = { ...c }; delete n[x.date]; return n; });
      }
      setLog(l => ({ ...l, snaps: last }));
      setSel(ok.length === 1 ? ok[0].date : last.at(-1).id);
      getPriceRules(cabinet).then(r => setRuleList(r.data.data || [])).catch(() => {});
      setMsg({ text: `Загружено снимков: ${ok.length}.${ruled ? ` С правилом (группой): ${ruled} арт.` : ''}${skipped.length ? ' Пропущено: ' + skipped.join('; ') : ''}` });
    } catch (x) { setMsg({ bad: true, text: 'Не удалось прочитать файл: ' + x.message }); } finally { setBusy(false); }
  }
  const mark = (offers, goal, note) => markPriceLog(cabinet, platform, sel, offers, goal, note).then(r => setLog(l => ({ ...l, marks: r.data.data.marks }))).catch(e => setMsg({ bad: true, text: e.message }));
  const [bulkGoal, setBulkGoal] = useState('');
  const [bulkNote, setBulkNote] = useState('');
  const togglePick = o => setPicked(p => { const n = new Set(p); if (n.has(o)) n.delete(o); else n.add(o); return n; });
  const openHist = o => { setHist({ o, rows: null }); getPriceHistory(cabinet, platform, o).then(r => setHist(h => (h?.o === o ? { o, rows: r.data.data } : h))).catch(() => setHist(h => (h?.o === o ? { o, rows: [] } : h))); };

  // Итог по целям недели: сколько артикулов и как в среднем изменились заказы.
  const goalSummary = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      if (!changed(r)) continue;
      const g = r.goal || (r.kind === 'down' ? '_down' : '_up');
      const v = m.get(g) || { n: 0, before: 0, after: 0 };
      v.n++; v.before += r.before; v.after += r.after || 0;
      m.set(g, v);
    }
    return [...m.entries()];
  }, [rows]);

  if (err && !log) return <div className="mpui"><div className="a-empty" style={{ padding: 40 }}>Не удалось загрузить: {err}</div></div>;
  if (!log) return <div className="mpui"><div className="a-empty" style={{ padding: 40, textAlign: 'center' }}>Загрузка…</div></div>;

  const ordCh = (b, a) => (b > 0 && daysAfter >= 3 ? ((a / daysAfter) / (b / 7) - 1) * 100 : null);
  const OrdCells = ({ before, after }) => (
    <>
      <td className="n r">{fmtInt(before)}</td>
      <td className="n r">{daysAfter > 0 ? <>{fmtInt(after)}<small className="pr-sub2">за {daysAfter} дн</small></> : '…'}</td>
      <td className="n r">{ordCh(before, after) !== null ? <span className={ordCh(before, after) >= 0 ? 's-up' : 's-down'}>{f1(ordCh(before, after))}</span> : daysAfter > 0 && before > 0 ? <span className="muted" title="Меньше 3 дней после изменения — по одному-двум дням судить рано">рано</span> : '—'}</td>
    </>
  );
  const topList = (m, k = 3) => { const a = [...m.entries()].sort((x, y) => y[1] - x[1]); return a.slice(0, k).map(([t, n]) => `${t} ${n}`).join(' · ') + (a.length > k ? ` · ещё ${a.length - k}` : ''); };

  return (
    <div className="mpui">
      <div className="page-sticky">
        <div className="a-top">
          <h1>Журнал цен</h1>
          <span className="a-seg"><button type="button" className="on">Ozon · Дефлай</button><button type="button" disabled title="Добавим позже">WB — позже</button></span>
          <span className="a-seg">{[['log', 'Журнал'], ['dyn', 'Динамика цен']].map(([k, t]) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t}</button>)}</span>
          <span className="a-hint" style={{ margin: 0 }}>{tab === 'log' ? 'цены для клиента из репрайсера, раз в неделю' : 'как меняются цены по категориям и артикулам'}</span>
        </div>
      </div>
      {tab === 'dyn' ? <PriceDynamics cabinet={cabinet} catOf={catOf} snaps={snaps} /> : (<>
      {msg && <div className={`c-msg ${msg.bad ? 'bad' : ''}`} style={{ margin: '10px 0' }}>{msg.text}</div>}

      <div className="a-card pr-card">
        <div className="a-bar" style={{ gap: 10, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 14 }}>Недели</b>
          <span className="pl-weeks">
            {snaps.map(s => (
              <button key={s.id} type="button" className={`s-chip ${sel === s.id ? 'on' : ''}`} onClick={() => setSel(s.id)} title={`${s.file}${s.fmt === 'two' ? `\nподняли ${s.up}, снизили ${s.down}` : ''}`}>
                {dayjs(s.date).format('DD.MM.YY')}<b className="n">{s.fmt === 'two' ? s.up + s.down : s.n}</b>
              </button>
            ))}
            {!snaps.length && <span className="muted">пока нет — загрузите первую выгрузку репрайсера</span>}
          </span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <input className="a-input" type="date" value={upDate} onChange={e => setUpDate(e.target.value)} title="Дата, с которой действуют новые цены (обычно среда). Если выбрать сразу несколько файлов, дата берётся из имени каждого" />
            <label className={`a-btn ${busy ? 'dis' : ''}`} style={{ cursor: 'pointer' }}>{busy ? 'Загружаю…' : 'Загрузить цены'}<input type="file" multiple accept=".xlsx,.xls,.csv" style={{ display: 'none' }} disabled={busy} onChange={onFiles} /></label>
            {curMeta && <button type="button" className="a-btn ghost" title="Удалить этот снимок" onClick={() => { if (window.confirm(`Удалить снимок цен на ${dayjs(curMeta.date).format('DD.MM.YYYY')}?`)) deletePriceLog(cabinet, platform, curMeta.id).then(r => { setLog(l => ({ ...l, snaps: r.data.data.snaps })); setSel(r.data.data.snaps.at(-1)?.id || null); }); }}>×</button>}
          </span>
        </div>
        <div className="a-hint" style={{ marginTop: 6 }}>
          Общий файл на все магазины: «Артикул · Defly · Alex · NABauto · Fullgas» — по колонке новых цен на магазин, пусто или 0 = без изменений; загружается сразу во все магазины, текущие цены («было») сервис берёт с сайта (плагин Соинвест). Подходит и выгрузка репрайсера «Артикул продавца · Название · Цена клиента на удержание · Новые цены».
          Прошлые недели можно догрузить: выберите сразу несколько файлов — дата возьмётся из имени («… 14.10.xlsx»).
        </div>
      </div>

      {curMeta && !ready && <div className="a-card pr-card"><div className="a-empty" style={{ padding: 20, textAlign: 'center' }}>Загрузка снимка…</div></div>}

      {ready && (
        <div className="a-card pr-card">
          <div className="a-bar" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 10 }}>
            <b style={{ fontSize: 14 }}>{two ? `Изменения цен с ${dayjs(cur.date).format('DD.MM.YYYY')}` : prev ? `Изменения ${dayjs(prev.date).format('DD.MM')} → ${dayjs(cur.date).format('DD.MM.YYYY')}` : `Первый снимок ${dayjs(cur.date).format('DD.MM.YYYY')} — изменения будут видны со следующей загрузки`}</b>
            {(two || prev) && <span className="a-hint" style={{ margin: 0 }}>заказы Ozon: 7 дней до {dayjs(cur.date).format('DD.MM')} и {daysAfter > 0 ? `${daysAfter} дн после (изменение — по заказам в день)` : 'после — ещё нет данных'}</span>}
          </div>
          {(two || prev) && (
            <>
              <div className="pl-sum">
                <button type="button" className={`pl-k up ${fKind === 'up' ? 'on' : ''}`} onClick={() => pickFilter(fKind === 'up' ? 'changed' : 'up')}><b>{cnt('up')}</b> подняли</button>
                <button type="button" className={`pl-k dn ${fKind === 'down' ? 'on' : ''}`} onClick={() => pickFilter(fKind === 'down' ? 'changed' : 'down')}><b>{cnt('down')}</b> снизили</button>
                <button type="button" className={`pl-k ${fKind === 'same' ? 'on' : ''}`} onClick={() => pickFilter(fKind === 'same' ? 'changed' : 'same')}><b>{cnt('same')}</b> без изменений</button>
                {cnt('zero') > 0 && <button type="button" className={`pl-k warn ${fKind === 'zero' ? 'on' : ''}`} onClick={() => pickFilter(fKind === 'zero' ? 'changed' : 'zero')} title="В колонке «Новые цены» стоит 0 — проверить, что репрайсер с ними делает"><b>{cnt('zero')}</b> новая цена 0</button>}
                {cnt('new') > 0 && <button type="button" className={`pl-k ${fKind === 'new' ? 'on' : ''}`} onClick={() => pickFilter(fKind === 'new' ? 'changed' : 'new')}><b>{cnt('new')}</b> новые</button>}
                {cnt('gone') > 0 && <button type="button" className={`pl-k ${fKind === 'gone' ? 'on' : ''}`} onClick={() => pickFilter(fKind === 'gone' ? 'changed' : 'gone')}><b>{cnt('gone')}</b> пропали</button>}
                {nMis > 0 && <button type="button" className={`pl-k dn ${fKind === 'mis' ? 'on' : ''}`} onClick={() => pickFilter(fKind === 'mis' ? 'changed' : 'mis')} title={`Цена с Ozon-картой на сайте отличается от цены в файле больше чем на ${MIS}%`}><b>{nMis}</b> расходится с сайтом</button>}
                {nDrift > 0 && <button type="button" className={`pl-k ${fKind === 'drift' ? 'on' : ''}`} onClick={() => pickFilter(fKind === 'drift' ? 'changed' : 'drift')} title="«Было» в этом файле не совпадает с «стало» прошлой загрузки — цену меняли между загрузками"><b>{nDrift}</b> менялась между загрузками</button>}
              </div>

              <div className="a-bar" style={{ gap: 8, margin: '4px 0 6px' }}>
                <b style={{ fontSize: 13.5 }}>Как меняли</b>
                <span className="a-seg">{[['rules', 'По правилам'], ['cats', 'По категориям']].map(([k, t]) => <button key={k} type="button" className={view === k ? 'on' : ''} onClick={() => setView(k)}>{t}</button>)}</span>
                <span className="a-hint" style={{ margin: 0 }}>клик по строке — показать эти артикулы в таблице ниже</span>
              </div>
              <div className="a-scroll">
                {view === 'rules' ? (
                  <table className="a-t pr-t pl-agg">
                    <thead><tr>
                      <th className="l">Правило</th><th className="r">Арт.</th><th className="l">Категории</th><th className="r">Средняя цена было</th><th className="r">стало</th>
                      <th className="r" title="Заказы Ozon за 7 дней до изменения">Заказы 7 дн до</th><th className="r" title="Заказы Ozon после изменения — фактически, за прошедшие дни">после</th><th className="r">изм.</th>
                    </tr></thead>
                    <tbody>
                      {!ruleRows.length && <tr><td colSpan={8} className="muted" style={{ padding: 12 }}>Цены не менялись</td></tr>}
                      {ruleRows.map(g => (
                        <tr key={g.key} className={`pl-click ${fGroup === g.key ? 'pr-in-order' : ''}`} onClick={() => pickFilter('changed', fGroup === g.key ? '' : g.key)}>
                          <td><b className={g.kind === 'zero' ? 's-down' : g.kind === 'user' ? (g.sb > g.sa ? 's-up' : 's-down') : g.sort > 0 ? 's-up' : 's-down'}>{g.kind === 'user' ? <span className="pl-user" title="Своё правило">★ </span> : null}{g.label}</b>{g.details.size > 0 && <small className="pr-sub2">{topList(g.details, 4)}</small>}</td>
                          <td className="n r"><b>{g.n}</b></td>
                          <td className="pl-cats">{topList(g.cats)}</td>
                          <td className="n r">{rub(g.sa / g.n)}</td>
                          <td className="n r">{g.kind === 'zero' ? '0 ₽' : rub(g.sb / g.n)}</td>
                          <OrdCells before={g.before} after={g.after} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <table className="a-t pr-t pl-agg">
                    <thead><tr>
                      <th className="l">Категория</th><th className="r">Подняли</th><th className="r">Снизили</th><th className="r">Без изм.</th><th className="r" title="Среднее изменение цены у изменённых">Ср. изменение</th><th className="l">Как меняли</th>
                      <th className="r" title="Заказы изменённых артикулов за 7 дней до">Заказы до</th><th className="r">после</th><th className="r">изм.</th>
                    </tr></thead>
                    <tbody>
                      {catRows.map(c => (
                        <tr key={c.cat} className={`pl-click ${fCat === c.cat ? 'pr-in-order' : ''}`} onClick={() => pickFilter('changed', '', fCat === c.cat ? '' : c.cat)}>
                          <td><b>{c.cat}</b></td>
                          <td className="n r">{c.up ? <span className="s-up">{c.up}</span> : '—'}</td>
                          <td className="n r">{c.down ? <span className="s-down">{c.down}</span> : '—'}{c.zero ? <small className="pr-sub2">+ {c.zero} с ценой 0</small> : null}</td>
                          <td className="n r">{c.same || '—'}</td>
                          <td className="n r">{c.nPct ? <span className={c.pct > 0 ? 's-up' : 's-down'}>{f1(c.pct / c.nPct)}</span> : '—'}</td>
                          <td className="pl-cats">{topList(c.rules)}</td>
                          <OrdCells before={c.before} after={c.after} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {goalSummary.length > 0 && (
                <div className="pl-goals" style={{ marginTop: 12 }}>
                  {goalSummary.map(([g, v]) => {
                    const ch = v.before > 0 && daysAfter > 0 ? ((v.after / daysAfter) / (v.before / 7) - 1) * 100 : null;
                    return (
                      <div key={g} className="pl-goal">
                        <div className="pl-goalt">{g === '_down' ? 'Снизили, цель не указана' : g === '_up' ? 'Подняли, цель не указана' : GOAL[g] || g}</div>
                        <div><b>{v.n}</b> арт. · заказы {fmtInt(v.before)} за 7 дн → {daysAfter > 0 ? `${fmtInt(v.after)} за ${daysAfter} дн` : '…'} {daysAfter >= 3 && ch !== null ? <b className={ch >= 0 ? 's-up' : 's-down'}>{f1(ch)}</b> : null}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {ready && (
        <div className="a-card pr-card" id="pl-table">
          <div className="a-bar" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <b style={{ fontSize: 14 }}>Артикулы</b>
            <span className="a-seg">
              {[['changed', 'Изменённые'], ['all', 'Все']].map(([k, t]) => <button key={k} type="button" className={fKind === k ? 'on' : ''} onClick={() => setFKind(k)}>{t}</button>)}
            </span>
            {(fGroup || fCat) && <button type="button" className="s-chip on" onClick={() => { setFGroup(''); setFCat(''); }} title="Снять отбор">{fGroup ? ruleRows.find(g => g.key === fGroup)?.label : fCat} ×</button>}
            <select className="a-input" value={fGoal} onChange={e => setFGoal(e.target.value)} style={{ padding: '5px 8px' }}>
              <option value="">Все цели</option><option value="—">Без цели</option>{GOALS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
            </select>
            <input className="a-input" placeholder="Артикул или категория" value={q} onChange={e => setQ(e.target.value)} style={{ minWidth: 200 }} />
            <span className="muted" style={{ fontSize: 12.5 }}>{shown.length} арт.</span>
            <ResetCtl ctl={ctl} style={{ marginLeft: 'auto' }} />
          </div>
          {picked.size > 0 && (
            <div className="pl-bulk">
              Выбрано {picked.size}:
              <select className="a-input" value={bulkGoal} onChange={e => setBulkGoal(e.target.value)}><option value="">цель…</option>{GOALS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}<option value="-">снять цель</option></select>
              <input className="a-input" placeholder="заметка (почему меняли)" value={bulkNote} onChange={e => setBulkNote(e.target.value)} style={{ minWidth: 260 }} />
              <button type="button" className="a-btn" onClick={() => { mark([...picked], bulkGoal === '-' ? null : bulkGoal || undefined, bulkNote || undefined); setBulkNote(''); setBulkGoal(''); setPicked(new Set()); }}>Сохранить</button>
              <span className="pl-rsep" />
              <input className="a-input" list="pl-rules" placeholder="правило (группа)" value={bulkRule} onChange={e => setBulkRule(e.target.value.slice(0, 60))} style={{ minWidth: 180 }} />
              <button type="button" className="a-btn" disabled={!bulkRule.trim()} onClick={() => { applyRule([...picked], bulkRule.trim()); setBulkRule(''); setPicked(new Set()); }}>Объединить в группу</button>
              <button type="button" className="a-btn ghost" title="Группа снова определится автоматически" onClick={() => { applyRule([...picked], ''); setPicked(new Set()); }}>снять правило</button>
              <datalist id="pl-rules">{ruleList.map(r => <option key={r} value={r} />)}</datalist>
              <button type="button" className="a-btn ghost" onClick={() => setPicked(new Set())}>Сбросить выбор</button>
            </div>
          )}
          <div className="a-scroll">
            <table className="a-t pr-t">
              <thead><tr>
                <th style={{ width: 28 }}><input type="checkbox" checked={vis.length > 0 && vis.every(r => picked.has(r.o))} onChange={e => setPicked(e.target.checked ? new Set(shown.map(r => r.o)) : new Set())} title="Выбрать все в списке" /></th>
                <ThCtl ctl={ctl} k="o" className="" filter={false}>Артикул</ThCtl>
                <ThCtl ctl={ctl} k="a">Было</ThCtl>
                <ThCtl ctl={ctl} k="b">Стало</ThCtl>
                <ThCtl ctl={ctl} k="d" unit="₽">Изменение</ThCtl>
                <ThCtl ctl={ctl} k="pct" unit="%">%</ThCtl>
                <ThCtl ctl={ctl} k="before" hint="Заказы Ozon за 7 дней до изменения цены">Заказы до</ThCtl>
                <ThCtl ctl={ctl} k="after" hint="Заказы Ozon после изменения — фактически, за прошедшие дни; % — по заказам в день к неделе до">Заказы после</ThCtl>
                <ThCtl ctl={ctl} k="off" unit="%" hint={`Цена для покупателя с Ozon-картой на сайте. Отличается от цены в файле больше чем на ${MIS}% — строка подсвечена: цена не применилась или её перебила акция`}>На сайте</ThCtl>
                <ThCtl ctl={ctl} k="goal" className="" filter={false}>Цель и заметка</ThCtl>
                <th style={{ textAlign: 'left' }}>Итог</th>
              </tr></thead>
              <tbody>
                {!vis.length && <tr><td colSpan={11} className="muted" style={{ padding: 14 }}>{two || prev ? 'Ничего не подходит под фильтр' : 'Изменения появятся после второй загрузки'}</td></tr>}
                {vis.map(r => (
                  <tr key={r.o} className={`${picked.has(r.o) ? 'pr-in-order' : ''} ${r.mis ? 'pl-mis' : ''}`}>
                    <td><input type="checkbox" checked={picked.has(r.o)} onChange={() => togglePick(r.o)} /></td>
                    <td><div className="a-art" style={{ cursor: 'pointer' }} onClick={() => openHist(r.o)} title="История цены и заказов"><div style={{ minWidth: 0 }}><div className="id">{r.o}</div><div className="model" title={r.cat}>{r.cat1}</div></div></div></td>
                    <td className="n r">{rub(r.a)}{r.drift ? <small className="pr-sub2 s-warn" title="Цена в прошлой загрузке («стало») — между загрузками цену меняли">в прошлой загрузке {rub(r.drift)}</small> : null}</td>
                    <td className="n r"><b>{r.kind === 'zero' ? <span className="s-down">0 ₽</span> : rub(r.b)}</b></td>
                    <td className="n r"><span className={r.d > 0 ? 's-up' : r.d < 0 ? 's-down' : ''}>{r.d ? drub(r.d) : '—'}</span></td>
                    <td className="n r"><span className={r.pct > 0 ? 's-up' : r.pct < 0 ? 's-down' : ''}>{r.pct ? f1(r.pct) : '—'}</span>{r.g && r.g.kind !== 'pct' ? <small className="pr-sub2">{r.g.kind === 'spot' ? 'точечно' : r.g.label}</small> : null}</td>
                    <td className="n r">{fmtInt(r.before)}</td>
                    <td className="n r">{daysAfter > 0 ? <>{fmtInt(r.after)}{r.before > 0 && daysAfter >= 3 ? <small className={`pr-sub2 ${r.afterN >= r.before ? 's-up' : 's-down'}`}>{f1((r.afterN / r.before - 1) * 100)}</small> : <small className="pr-sub2">за {daysAfter} дн</small>}</> : '…'}</td>
                    <td className={`n r ${r.mis ? 'pl-bad' : ''}`}>{r.st?.card ? <span title={`с Ozon-картой ${rub(r.st.card)}${r.st.noCard ? `, без карты ${rub(r.st.noCard)}` : ''}, проверено ${r.st.at || '—'}${r.st.stored ? ' (запомнено при загрузке, против «было»)' : ''}`}>{rub(r.st.card)}{r.off !== null ? <small className={`pr-sub2 ${r.mis ? 's-down' : ''}`}>{r.mis ? 'расходится ' : ''}{f1(r.off)}</small> : null}</span> : '—'}</td>
                    <td className="pr-l pl-gl" style={{ minWidth: 220 }}>
                      <select className="a-input pr-sel" value={r.goal} onChange={e => mark([r.o], e.target.value || null, undefined)}>
                        <option value="">— цель —</option>{GOALS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                      </select>
                      <input className="a-input pl-note" defaultValue={r.note} key={sel + r.o + r.note} placeholder="заметка" onBlur={e => { if (e.target.value !== r.note) mark([r.o], undefined, e.target.value || null); }} />
                    </td>
                    <td className="pr-l" style={{ whiteSpace: 'normal', minWidth: 220 }}>{r.v ? <span className={`pr-sig ${r.v.cls}`} style={{ whiteSpace: 'normal' }}>{r.v.t}</span> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.length > 50 && <button type="button" className="s-fold" onClick={() => setFull(f => !f)}>{full ? 'Свернуть ▲' : `Показать все ${shown.length} ▼`}</button>}
        </div>
      )}

      {hist && (
        <div className="pl-modal" onClick={() => setHist(null)}>
          <div className="a-card pl-modalc" onClick={e => e.stopPropagation()}>
            <div className="a-bar" style={{ marginBottom: 8 }}><b style={{ fontSize: 15 }}>{hist.o}</b><span className="a-hint" style={{ margin: 0 }}>{ord?.cat.get(hist.o) || ''}</span>
              <button type="button" className="a-btn ghost" style={{ marginLeft: 'auto' }} onClick={() => setHist(null)}>×</button></div>
            {!hist.rows ? <div className="muted" style={{ padding: 12 }}>Загрузка…</div> : (
              <table className="a-t pr-t">
                <thead><tr><th className="l">Неделя</th><th className="r">Было</th><th className="r">Стало</th><th className="r">Изменение</th><th className="r">Заказы 7 дн до</th><th className="r">7 дн после</th><th className="l">Цель / заметка</th></tr></thead>
                <tbody>
                  {hist.rows.slice().reverse().map((x, i, arr) => {
                    const a = x.a ?? arr[i + 1]?.p ?? null, ch = a ? (x.p / a - 1) * 100 : null, mk = (log.marks[x.id] || {})[hist.o];
                    return (
                      <tr key={x.id}>
                        <td>{dayjs(x.date).format('DD.MM.YYYY')}</td>
                        <td className="n r">{rub(a)}</td>
                        <td className="n r"><b>{rub(x.p)}</b></td>
                        <td className="n r"><span className={ch > 0 ? 's-up' : ch < 0 ? 's-down' : ''}>{ch && Math.abs(ch) >= 0.05 ? f1(ch) : '—'}</span></td>
                        <td className="n r">{fmtInt(sumOrders(hist.o, dayjs(x.date).subtract(7, 'day'), 7))}</td>
                        <td className="n r">{fmtInt(sumOrders(hist.o, x.date, 7))}</td>
                        <td className="pr-l" style={{ whiteSpace: 'normal' }}>{mk?.goal ? GOAL[mk.goal] : ''}{mk?.note ? <span className="muted"> — {mk.note}</span> : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
      </>)}
    </div>
  );
}
