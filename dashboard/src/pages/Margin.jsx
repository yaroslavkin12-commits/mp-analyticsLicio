import React, { useState, useEffect, useMemo, useRef } from 'react';
import dayjs from 'dayjs';
import { getCalcBase, refreshPrices, getFinanceCoefs, getFinancePnl } from '../api';
import { unitCoefs } from './unitModel';
import { fmtInt, CAT_COLORS } from './AdsStats2';
import { baseOf, compute, priceFor, DEFAULTS, drrPred } from './Calculator';
import { useCats, useGroups, FinHeader, Kpi, inPath, matchQ, pct1, useTax, useBuyerShare, OTHER, SEP } from './finShared';
import { useTableCtl, ThCtl, ResetCtl } from '../components/TableTools';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «Цены и маржа» — по каждому товару при его текущей цене: прибыль на 1
// проданную штуку, маржа, ROI, цена безубыточности и цена под целевую
// маржу. Расчёт — тот же, что в калькуляторе (база за 30 дней: комиссия
// FBO из карточки / FBS по факту, выкуп, логистика на отправку и возврат,
// эквайринг, хранение и прочее, реклама — фактический ДРР товара).
// Схема товара — та, через которую идёт большинство его заказов.
// ─────────────────────────────────────────────────────────────────────────

// Колонки таблицы (выбираются кнопкой «Колонки»). money — можно показать «на 1 шт» или «всего за 30 дней».
const COL_LIST = [
  ['price', 'Цена реализации'], ['client', 'Цена клиента'], ['set', 'Установить цену'], ['cost', 'Себестоимость', 1], ['drr', 'ДРР'], ['comm', 'Комиссия', 1], ['logi', 'Логистика', 1],
  ['ads', 'Реклама', 1], ['tax', 'Налог', 1], ['pay', 'На счёт', 1], ['profit', 'Прибыль', 1], ['fact', 'Прибыль факт (P&L)'], ['margin', 'Маржа и ROI'], ['buyout', 'Выкуп %'], ['spp', 'СПП %'],
  ['be', 'Безубыток (реализации и клиента)'], ['tp', 'Цена для цели (реализации и клиента)'], ['rev', 'Заказы 30 дн'],
];
const MONEY = new Set(COL_LIST.filter(c => c[2]).map(c => c[0]));
const DEF_COLS = ['price', 'client', 'set', 'cost', 'drr', 'pay', 'profit', 'fact', 'margin', 'be', 'tp', 'rev'];

const FILTERS = [['loss', 'Убыточные', 'b'], ['below', 'Ниже цели', 'w'], ['nocost', 'Нет себестоимости', 'm'], ['ok', 'В норме', 'g']];

// Поле в ячейке: показывает текущее значение; вписали своё — подсвечивается,
// а прежнее значение уходит ниже мелким синим (кнопка «вернуть»).
function EditNum({ value, base, onChange, fmt, width, step = '1', title }) {
  const [focus, setFocus] = useState(false);
  const ed = value !== '' && value !== undefined;
  return (
    <input className={`a-input m-ed ${ed ? 'ed' : ''}`} style={{ width }} title={title} inputMode="decimal" step={step}
      value={ed ? value : focus ? '' : fmt(base)} placeholder={fmt(base)}
      onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
      onChange={e => onChange(e.target.value.replace(',', '.').replace(/[^\d.]/g, ''))} />
  );
}

// Поле новой цены: печатаем без пересчёта таблицы на каждую цифру — значение
// уходит в расчёт через 0,4 с паузы или сразу при уходе с поля / Enter.
function SetInput({ value, placeholder, onCommit, ed, title }) {
  const [v, setV] = useState(value === '' || value === undefined || value === null ? '' : String(value));
  const focus = useRef(false), timer = useRef(null);
  useEffect(() => { if (!focus.current) setV(value === '' || value === undefined || value === null ? '' : String(value)); }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const commit = x => { clearTimeout(timer.current); onCommit(x); };
  return (
    <input className={`a-input m-ed ${ed ? 'ed' : ''}`} style={{ width: 86 }} inputMode="decimal" value={v} placeholder={placeholder} title={title}
      onFocus={() => { focus.current = true; }} onBlur={() => { focus.current = false; commit(v); }}
      onKeyDown={e => { if (e.key === 'Enter') { commit(v); e.currentTarget.blur(); } }}
      onChange={e => { const x = e.target.value.replace(',', '.').replace(/[^\d.]/g, ''); setV(x); clearTimeout(timer.current); timer.current = setTimeout(() => onCommit(x), 400); }} />
  );
}

// Выбор колонок таблицы — как в конструкторе: включить/выключить, «по умолчанию».
function ColPicker({ cols, setCols, target }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const on = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [open]);
  const tog = k => setCols(c => (c.includes(k) ? c.filter(x => x !== k) : [...c, k]));
  return (
    <span ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="a-btn ghost" onClick={() => setOpen(o => !o)}>Колонки ({cols.length}) ▾</button>
      {open && (
        <div className="m-colpop">
          {COL_LIST.map(([k, t]) => (
            <label key={k}><input type="checkbox" checked={cols.includes(k)} onChange={() => tog(k)} />{t.replace('для цели', `для ${target}%`)}</label>
          ))}
          <div className="m-colact"><button type="button" className="tt-reset" onClick={() => setCols(DEF_COLS)}>↺ по умолчанию</button><button type="button" className="tt-reset" onClick={() => setCols(COL_LIST.map(c => c[0]))}>все</button></div>
        </div>
      )}
    </span>
  );
}

export default function Margin({ cabinet }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState('');
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState(20);
  // ДРР: по умолчанию — фактический за 30 дней (реклама / заказы товара);
  // можно задать один для всех или свой по каждому товару — как в калькуляторе.
  const lsKey = `mp-margin-drr:${cabinet}`;
  const [drrAll, setDrrAll] = useState('');
  const [drrOver, setDrrOver] = useState({});
  // Новые цены: { артикул: { v, m } }, m — в какой цене вписано ('real' — реализации, 'client' — клиента).
  const [priceOver, setPriceOver] = useState({});
  const [setMode, setSetMode] = useState(() => { try { return localStorage.getItem('mp-margin-setmode') || 'client'; } catch (e) { return 'client'; } });
  useEffect(() => { try { localStorage.setItem('mp-margin-setmode', setMode); } catch (e) { /* ignore */ } }, [setMode]);
  const [full, setFull] = useState(false);
  const [per, setPer] = useState('unit'); // unit — на 1 шт, total — всего за 30 дней
  const pinKey = `mp-margin-pin:${cabinet}`;
  const [pinned, setPinned] = useState([]);
  useEffect(() => { try { setPinned(JSON.parse(localStorage.getItem(pinKey) || '[]')); } catch (e) { setPinned([]); } }, [pinKey]);
  useEffect(() => { try { localStorage.setItem(pinKey, JSON.stringify(pinned)); } catch (e) { /* ignore */ } }, [pinKey, pinned]);
  const [cols, setCols] = useState(() => { try { const v = JSON.parse(localStorage.getItem('mp-margin-cols') || 'null'); return Array.isArray(v) ? v : DEF_COLS; } catch (e) { return DEF_COLS; } });
  useEffect(() => { try { localStorage.setItem('mp-margin-cols', JSON.stringify(cols)); } catch (e) { /* ignore */ } }, [cols]);
  const [withAds, setWithAds] = useState(true);
  const [allArts, setAllArts] = useState(false); // показывать и товары без заказов за 30 дней
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    try { const v = JSON.parse(localStorage.getItem(lsKey) || '{}'); setDrrAll(v.all ?? ''); setDrrOver(v.over || {}); setPriceOver(Object.fromEntries(Object.entries(v.price || {}).map(([o, x]) => [o, typeof x === 'object' ? x : { v: Number(x), m: 'real' }]))); setWithAds(v.ads !== false); }
    catch (e) { setDrrAll(''); setDrrOver({}); setPriceOver({}); setWithAds(true); }
    setReady(true);
  }, [lsKey]);
  useEffect(() => { if (ready) try { localStorage.setItem(lsKey, JSON.stringify({ all: drrAll, over: drrOver, price: priceOver, ads: withAds })); } catch (e) { /* ignore */ } }, [ready, lsKey, drrAll, drrOver, priceOver, withAds]);
  const upd = set => (o, val) => set(m => { const n = { ...m }; if (val === '' || val === null || val === undefined) delete n[o]; else n[o] = val; return n; });
  const setOver = upd(setDrrOver);
  const setPrice = (o, val, m = setMode) => setPriceOver(mm => { const n = { ...mm }; if (val === '' || val === null || val === undefined || !(Number(val) > 0)) delete n[o]; else n[o] = { v: Number(val), m }; return n; });
  const [flt, setFlt] = useState(null);
  const [tax] = useTax(cabinet);
  const grp = useGroups(cabinet);
  const ctl = useTableCtl('margin', { k: 'margin', dir: 1 });

  useEffect(() => { setData(null); getCalcBase(cabinet).then(r => setData(r.data.data)).catch(e => setError(e.response?.data?.error || e.message)); }, [cabinet]);
  // Коэффициенты единой модели прибыли (те же, что в «Юнит-экономике» и «Рекламе»).
  const [coefs, setCoefs] = useState(null);
  useEffect(() => { setCoefs(null); getFinanceCoefs(cabinet).then(r => setCoefs(r.data.data)).catch(() => setCoefs(false)); }, [cabinet]);
  // Факт за 30 дней по начислениям Ozon (как в P&L) — для сравнения с прогнозом.
  const [pnl, setPnl] = useState(null);
  useEffect(() => {
    setPnl(null);
    getFinancePnl(cabinet, { dateFrom: dayjs().subtract(29, 'day').format('YYYY-MM-DD'), dateTo: dayjs().format('YYYY-MM-DD') }).then(r => setPnl(r.data.data)).catch(() => setPnl(false));
  }, [cabinet]);
  // Ручное обновление цен: Google-скрипт выгружает свежие цены и комиссии из Ozon
  // в таблицу, сервис их забирает и пересчитывает страницу.
  const [refr, setRefr] = useState({ busy: false, msg: '' });
  const doRefresh = async () => {
    setRefr({ busy: true, msg: 'Обновляем цены…' });
    try {
      const f = await refreshPrices(cabinet);
      const r = await getCalcBase(cabinet, true);
      setData(r.data.data);
      const t = f.data.data?.checkedAt ? new Date(f.data.data.checkedAt) : null;
      setRefr({ busy: false, msg: t ? `Цены из Ozon на ${t.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : 'Цены обновлены' });
    } catch (e) {
      setRefr({ busy: false, msg: `Не удалось обновить: ${e.response?.data?.error || e.message}` });
    }
  };
  const cats = useCats(data?.articles, data?.order);
  const bs = useBuyerShare(cabinet, cats.arts);
  // Прибыль факт по артикулу (как строка артикула в P&L, без начислений без артикула):
  // выручка + все удержания Ozon (реклама — по начислениям, за ещё не проведённые дни — из кабинета)
  // − себестоимость выкупленного − налог (от доли цены, которую платит покупатель, по «Начислениям»).
  const fact = useMemo(() => {
    if (!pnl) return null;
    const iAds = pnl.buckets.indexOf('ads');
    let lastFin = -1;
    for (const r of pnl.rows) if (r[2] === iAds && r[3]) lastFin = Math.max(lastFin, r[1]);
    const m = new Map();
    const get = ai => { const o = pnl.articles[ai]?.o; if (!o) return null; let v = m.get(o); if (!v) { v = { sum: 0, rev: 0, qty: 0, ads: 0, ai }; m.set(o, v); } return v; };
    for (const [ai, d, bi, a, q] of pnl.rows) {
      const v = get(ai); if (!v) continue;
      const k = pnl.buckets[bi];
      v.sum += a;
      if (k === 'ads') v.ads -= a;
      if (k === 'sale') { v.rev += a; v.qty += Math.abs(q); } else if (k === 'return') { v.rev += a; v.qty -= Math.abs(q); }
    }
    for (const [ai, d, val] of pnl.ads) if (d > lastFin) { const v = get(ai); if (v) { v.sum -= val; v.ads += val; } }
    for (const [ai, , q] of pnl.self || []) { const v = get(ai); if (v) v.self = (v.self || 0) + q; } // самовыкупы — без себестоимости
    return m;
  }, [pnl]);
  const K = useMemo(() => {
    if (!coefs) return null;
    const arts = cats.arts.map(a => ({ o: a.o, parts: a.parts }));
    const ks = unitCoefs(coefs, arts, bs.shareOf);
    return new Map(arts.map((a, i) => [a.o, ks[i]]));
  }, [coefs, cats.arts, bs.shareOf]);

  const pinSet = useMemo(() => new Set(pinned), [pinned]);
  // Входные данные расчёта по каждому товару: свои → категория → кабинет.
  // Тяжёлая часть (коэффициенты, безубыток, цена под цель) — без вписанных цен, чтобы ввод не тормозил.
  const baseRows = useMemo(() => {
    if (!data) return [];
    const byArt = new Map(data.a.map(x => [x[0], x]));
    const byCat = new Map();
    for (const x of data.a) { const c = cats.arts[x[0]]?.cat; if (!c) continue; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(x); }
    const cache = new Map();
    const catBase = (c, scheme) => { const k = c + '|' + scheme; if (!cache.has(k)) cache.set(k, baseOf(byCat.get(c) || [], scheme)); return cache.get(k); };
    const allBase = { fbo: baseOf(data.a, 'fbo'), fbs: baseOf(data.a, 'fbs') };
    const out = [];
    const skipped = { noOrd: 0, noPrice: 0 };
    out.skipped = skipped;
    for (const a of cats.arts) {
      const x = byArt.get(a.i);
      if (!x || !x[1]) { skipped.noPrice++; continue; }
      const hasOrd = x[13] > 0 || x[25] > 0 || x[24] > 0;
      if (!hasOrd) { skipped.noOrd++; if (!allArts && !pinSet.has(a.o)) continue; } // по умолчанию — только товары с заказами за 30 дней
      const scheme = x[13] > 0 && x[14] / x[13] > 0.5 ? 'fbs' : 'fbo';
      const own = baseOf([x], scheme), cb = catBase(a.cat, scheme), ab = allBase[scheme];
      const pick = (k, minOwn) => { for (const b of [own, cb, ab]) if (b && b[k] !== null && b[k] !== undefined && (b !== own || !minOwn || minOwn(b))) return b[k]; return DEFAULTS[k] ?? 0; };
      const commission = scheme === 'fbs' ? (own.commFact ?? cb?.commFact ?? own.commCard ?? pick('commCard')) : (own.commCard ?? pick('commCard'));
      const k = K?.get(a.o);
      const v = k ? {
        // Единая модель (как в «Юнит-экономике»): выкуп, комиссия в доле FBO/FBS, логистика на
        // отправку и возврат, эквайринг и прочее, налог от цены клиента.
        spp: k.spp, cost: x[12] || 0, buyout: k.buyout * 100, defect: 0, commission: k.comm * 100,
        acquiring: k.acq * 100, direct: k.direct ?? k.logi, ret: k.direct !== null && k.direct !== undefined ? k.ret : 0, other: k.other * 100, drr: 0, oper: 0, tax,
      } : {
        // Скидка покупателя — текущая с сайта (Соинвест, с Ozon-картой); нет — по отчёту «Начисления».
        spp: x[11] !== null && x[11] !== undefined ? x[11] : bs.shareOf ? (1 - bs.shareOf(a.o, a.parts)) * 100 : 0, cost: x[12] || 0, buyout: pick('buyout'), defect: 0, commission: commission ?? DEFAULTS.commission,
        acquiring: pick('acquiring'), direct: pick('direct'), ret: pick('ret'), other: pick('other'), drr: 0, oper: 0, tax,
      };
      // ДРР — свой фактический за 30 дней (0, если товар не рекламировался). Средний по
      // категории сюда не подставляем: у товара без рекламы реклама и правда 0.
      const factDrr = drrPred(own, v.buyout) ?? 0;
      const drr7 = drrPred(own, v.buyout, 'drrOrd7');
      const ov = drrOver[a.o];
      v.drr = !withAds ? 0 : ov !== undefined && ov !== '' && Number.isFinite(Number(ov)) ? Number(ov) : drrAll !== '' && Number.isFinite(Number(drrAll)) ? Number(drrAll) : factDrr;
      const drrSrc = !withAds ? 'off' : ov !== undefined && ov !== '' ? 'own' : drrAll !== '' ? 'all' : 'fact';
      const curPrice = x[1];
      const sppK = 1 - (v.spp || 0) / 100;
      const price = curPrice;
      // Цена клиента сейчас: с сайта (с Ozon-картой), иначе — цена реализации со скидкой Ozon.
      const curClient = x[34] || curPrice * sppK;
      const r = compute(v, price, 'usn_income');
      // Предел маржи: при любой цене процентные расходы (комиссия, реклама как % от цены,
      // эквайринг, налог) не дают марже подняться выше этого значения.
      const maxM = compute(v, 1e7, 'usn_income').margin;
      // Цену дальше 3× от текущей не показываем — это «ценой не достичь», а не рекомендация.
      const cap = p => (p && p <= price * 3 ? p : null);
      const beRaw = priceFor(v, 'usn_income', 0), tpRaw = priceFor(v, 'usn_income', target);
      const be = cap(beRaw), tp = cap(tpRaw);
      const tpNo = !tp, beNo = !be;
      const status = !x[12] ? 'nocost' : r.profit < 0 ? 'loss' : r.margin < target ? 'below' : 'ok';
      const tpc = tp ? tp * sppK : null;
      const units = (x[25] || 0) * (v.buyout || 0) / 100; // ожидаемо продано за 30 дней (заказы × выкуп)
      const f = fact?.get(a.o);
      let pf = null;
      if (f) {
        const sh = bs.shareOf ? (bs.shareOf(a.o, a.parts) ?? 1) : 1;
        const costP = pnl.cost?.[f.ai] || x[12] || 0;
        const taxF = f.rev > 0 ? f.rev * sh * tax / 100 : 0;
        pf = { profit: f.sum - costP * (f.qty - (f.self || 0)) - taxF, rev: f.rev, qty: f.qty, ads: f.ads };
      }
      out.push({ a, x, scheme, v, r, rb: r, pf, be, tp, tpc, beNo, tpNo, maxM, status, orders: x[25], rev: x[24], factDrr, drr7, drrSrc, curPrice, curClient, sppK, units, po: null, priceEd: false });
    }
    return out;
  }, [data, cats.arts, target, drrAll, drrOver, withAds, tax, bs.shareOf, allArts, pinSet, K, fact]);
  // Вписанные новые цены: пересчитываем только эти строки (rb — при текущей цене, для сортировки,
  // чтобы строка не «убегала», пока вписываешь).
  const rows = useMemo(() => baseRows.map(b => {
    const po = priceOver[b.a.o];
    if (!(po && Number(po.v) > 0)) return b;
    const price = po.m === 'client' && b.sppK > 0 ? Number(po.v) / b.sppK : Number(po.v);
    const r = compute(b.v, price, 'usn_income');
    const status = !b.x[12] ? 'nocost' : r.profit < 0 ? 'loss' : r.margin < target ? 'below' : 'ok';
    return { ...b, r, status, po, priceEd: true };
  }), [baseRows, priceOver, target]);

  const q = search.trim().toLowerCase();
  const base = rows.filter(r => inPath(r.a, sel) && matchQ(r.a, q) && grp.test(r.a) && !pinSet.has(r.a.o));
  const pinRows = pinned.map(o => rows.find(r => r.a.o === o)).filter(Boolean);
  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, base.filter(r => r.status === k).length]));
  const GET = {
    o: r => r.a.o, price: r => r.rb.P, buyer: r => (r.v.spp ? r.rb.buyerPrice : null), cost: r => r.v.cost || null, profit: r => r.rb.profit,
    margin: r => (r.status === 'nocost' ? null : r.rb.margin), roi: r => r.rb.roi, be: r => r.be || null, tp: r => r.tp || null,
    gap: r => (r.tp ? r.tp - r.rb.P : null), rev: r => r.rev, drr: r => r.v.drr, pay: r => r.rb.payout,
    client: r => r.curClient, comm: r => r.rb.commission, logi: r => r.rb.logistics, ads: r => r.rb.ads, tax: r => r.rb.tax, buyout: r => r.v.buyout, spp: r => r.v.spp,
    fact: r => (r.pf ? (per === 'total' ? r.pf.profit : r.pf.qty > 0 ? r.pf.profit / r.pf.qty : null) : null),
    set: r => (r.priceEd ? r.r.P : null),
  };
  const getK = (r, k) => { const v = GET[k] ? GET[k](r) : null; return per === 'total' && MONEY.has(k) && v !== null ? v * r.units : v; };
  const shown = ctl.apply(flt ? base.filter(r => r.status === flt) : base, getK).slice(0, 2000);
  const withCost = base.filter(r => r.status !== 'nocost');
  const avgMargin = (() => { let p = 0, rv = 0; for (const r of withCost) { p += r.r.profit * r.orders; rv += r.r.P * r.orders; } return rv ? p / rv * 100 : null; })();
  const lossRev = base.filter(r => r.status === 'loss').reduce((s, r) => s + r.rev, 0);

  const pin = offers => setPinned(p => { const n = [...p]; for (const o of offers) if (!n.includes(o)) n.push(o); return n; });
  const unpin = o => setPinned(p => p.filter(x => x !== o));
  // Цена строки в выбранном виде (клиента / реализации): вписанная новая или текущая.
  const newIn = (r, mode = setMode) => {
    if (r.priceEd) return mode === 'client' ? r.r.P * r.sppK : r.r.P;
    return mode === 'client' ? r.curClient : r.curPrice;
  };
  const inputVal = r => {
    if (!r.po) return '';
    if (r.po.m === setMode) return r.po.v;
    return Math.round(setMode === 'client' ? r.po.v * r.sppK : r.po.v / (r.sppK || 1));
  };
  async function exportXlsx(list) {
    if (!list.length) return;
    const XLSX = await import('xlsx');
    const aoa = [['Артикул', 'Новая цена'], ...list.map(r => [r.a.o, Math.round(newIn(r))])];
    const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = [{ wch: 18 }, { wch: 12 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Цены');
    XLSX.writeFile(wb, `Новые цены (${setMode === 'client' ? 'цена клиента' : 'цена реализации'}) ${dayjs().format('DD.MM.YYYY')}.xlsx`);
  }
  const tot = per === 'total';
  const mul = r => (tot ? r.units : 1);
  const money = (r, v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : fmtInt(v * mul(r)));
  const H = {
    price: ['Цена реализации', 'Цена в кабинете (до скидки Ozon). Если вписана новая цена — ниже стрелкой, и все колонки считаются по ней'],
    client: ['Цена клиента', 'Цена для покупателя с Ozon-картой (с сайта; нет — цена реализации со скидкой Ozon). Ниже — СПП'],
    cost: [`Себест.${tot ? ' за 30 дн' : ''}`, 'Себестоимость штуки' + (tot ? ' × ожидаемо продано за 30 дней' : '')],
    drr: ['ДРР', 'ДРР прогнозный за 30 дней: расход на рекламу (из рекламного кабинета, оплата за заказ — на дату заказа) / (сумма заказов × % выкупа) — сколько реклама стоит с каждой проданной штуки. Наведите на значение — там же ДРР за 7 дней. Впишите свой — пересчитаются прибыль, маржа и цены'],
    comm: [`Комиссия${tot ? ' за 30 дн' : ''}`, 'Комиссия Ozon, ₽; ниже — %'],
    logi: [`Логистика${tot ? ' за 30 дн' : ''}`, 'Логистика с учётом невыкупов (отправка и возврат)'],
    ads: [`Реклама${tot ? ' за 30 дн' : ''}`, 'Реклама по ДРР'],
    tax: [`Налог${tot ? ' за 30 дн' : ''}`, 'Налог от оплаты покупателя'],
    pay: [`На счёт${tot ? ' за 30 дн' : ' / шт'}`, 'Поступление на счёт: цена минус комиссия, эквайринг, логистика, хранение и реклама'],
    profit: [`Прибыль${tot ? ' за 30 дн' : ' / шт'}`, tot ? 'Прибыль за 30 дней: прибыль со штуки × ожидаемо продано (заказы × выкуп)' : 'Прибыль с одной проданной штуки после всех расходов, рекламы и налога'],
    fact: [`Прибыль факт${tot ? ' за 30 дн' : ' / шт'}`, `Факт по начислениям Ozon за последние 30 дней — как строка артикула в P&L (без общих начислений без артикула): ${tot ? 'всего' : 'на одну выкупленную штуку'}. Отличается от прогноза: выкупы и списания приходят с задержкой, возвраты, разовые удержания, другая цена в прошлом`],
    margin: ['Маржа', 'Прибыль / выручка; ниже — ROI (прибыль / себестоимость)'],
    buyout: ['Выкуп', 'Доля выкупа, по которой считается логистика'],
    spp: ['СПП', 'Скидка Ozon для покупателя'],
    be: ['Безубыток', 'Цена, при которой прибыль = 0: сверху — цена реализации, ниже — цена клиента (со скидкой Ozon). Нажмите — подставится в «Установить цену»'],

    tp: [`Цена для ${target}%`, `Цена, при которой маржа ${target}%: сверху — цена реализации, ниже — цена клиента и на сколько поднять / можно снизить. Нажмите — подставится в «Установить цену». Цель меняется в шапке («целевая маржа»)`],

    rev: ['Заказы 30 дн', 'Заказы за 30 дней: сумма, ниже — штуки'],
    set: [`Установить цену (${setMode === 'client' ? 'клиента' : 'реализации'})`, 'Впишите новую цену — пересчитаются все колонки строки. Переключатель «новая цена —» над таблицей: в какой цене вписывать и выгружать. Пустая — в файл уйдёт текущая'],
  };
  const why = (v, maxM) => `Даже при очень высокой цене маржа не выше ${pct1(maxM)}: комиссия ${pct1(v.commission)}, реклама ${pct1(v.drr)}, эквайринг ${pct1(v.acquiring)}, прочее ${pct1(v.other)}, налог ${pct1(v.tax)} от оплаты покупателя`;
  // Рекомендованная цена: сверху — реализации, ниже — клиента; нажатие подставляет её в «Установить цену»
  // (в той цене, что выбрана переключателем «новая цена —»), округлив вверх до рубля.
  const pickPrice = (row, p) => (
    <button type="button" className="m-pick" title={`Подставить в «Установить цену»: ${setMode === 'client' ? 'цена клиента' : 'цена реализации'} ${fmtInt(Math.ceil(setMode === 'client' ? p * row.sppK : p))} ₽`}
      onClick={() => setPrice(row.a.o, String(Math.ceil(setMode === 'client' ? p * row.sppK : p)))}>
      <b>{fmtInt(p)}</b><small className="m-sub">клиент {fmtInt(p * row.sppK)}</small>
    </button>
  );
  const CELL = {
    price: row => (<td className="n r" key="price">{fmtInt(row.curPrice)}{row.priceEd ? <small className="m-sub m-new">→ {fmtInt(row.r.P)}</small> : null}</td>),
    client: row => (<td className="n r" key="client">{fmtInt(row.curClient)}{row.priceEd ? <small className="m-sub m-new">→ {fmtInt(row.r.P * row.sppK)}</small> : row.v.spp ? <small className="m-sub">СПП {pct1(row.v.spp)}</small> : null}</td>),
    cost: row => (<td className="n r" key="cost">{row.v.cost ? money(row, row.v.cost) : <span className="pill m">нет</span>}</td>),
    drr: row => (<td className="r" key="drr">{row.drrSrc === 'off' ? <span className="muted">—</span> : <>
      <EditNum value={drrOver[row.a.o] ?? ''} base={row.drrSrc === 'all' ? Number(drrAll) : row.factDrr} onChange={val => setOver(row.a.o, val)} fmt={x => String(Math.round(x * 10) / 10).replace('.', ',')} width={52} step="0.5" title={`Прогнозный ДРР за 30 дней: реклама / (заказы × выкуп ${pct1(row.v.buyout)}) = ${pct1(row.factDrr)}${row.drr7 !== null && row.drr7 !== undefined ? ` · за 7 дней ${pct1(row.drr7)}` : ''}`} />
      {row.drrSrc !== 'fact' && <button type="button" className="m-was" title="Вернуть ДРР за 30 дней" onClick={() => setOver(row.a.o, '')}>↺ {pct1(row.factDrr)}</button>}</>}</td>),
    comm: row => (<td className="n r" key="comm">{money(row, row.r.commission)}<small className="m-sub">{pct1(row.v.commission)}</small></td>),
    logi: row => (<td className="n r" key="logi">{money(row, row.r.logistics)}</td>),
    ads: row => (<td className="n r" key="ads">{money(row, row.r.ads)}</td>),
    tax: row => (<td className="n r" key="tax">{money(row, row.r.tax)}</td>),
    pay: row => (<td className="n r" key="pay">{money(row, row.r.payout)}</td>),
    profit: row => (<td className="n r" key="profit" title={`На 1 шт: комиссия ${fmtInt(row.r.commission)}, логистика ${fmtInt(row.r.logistics)} (×${row.r.trips.toFixed(2)}), эквайринг ${fmtInt(row.r.acquiring)}, прочее ${fmtInt(row.r.other)}, реклама ${fmtInt(row.r.ads)}, налог ${fmtInt(row.r.tax)}${tot ? ` · продано ≈ ${fmtInt(row.units)} шт` : ''}`}>
      <b style={{ color: row.r.profit < 0 ? 'var(--a-bad)' : undefined }}>{money(row, row.r.profit)}</b>{tot ? <small className="m-sub">≈ {fmtInt(row.units)} шт</small> : null}</td>),
    fact: row => { const f = row.pf; const v = !f ? null : tot ? f.profit : f.qty > 0 ? f.profit / f.qty : null; return (
      <td className="n r" key="fact" title={f ? `Выручка ${fmtInt(f.rev)} ₽, выкуплено ${fmtInt(f.qty)} шт, реклама ${fmtInt(f.ads)} ₽ — за 30 дней по начислениям` : pnl === null ? 'Загрузка…' : 'Нет начислений за 30 дней'}>
        {v === null ? <span className="muted">{pnl === null ? '…' : '—'}</span> : <span style={{ color: v < 0 ? 'var(--a-bad)' : undefined }}>{fmtInt(v)}</span>}
        {f && f.qty > 0 && !tot ? <small className="m-sub">{fmtInt(f.qty)} шт</small> : null}</td>); },
    margin: row => (<td className="r" key="margin"><span className={`pill ${row.status === 'nocost' ? 'm' : row.r.profit < 0 ? 'b' : row.r.margin < target ? 'w' : 'g'}`}>{pct1(row.r.margin)}</span><small className="m-sub">ROI {pct1(row.r.roi)}</small></td>),
    buyout: row => (<td className="n r" key="buyout">{pct1(row.v.buyout)}</td>),
    spp: row => (<td className="n r" key="spp">{row.v.spp ? pct1(row.v.spp) : '—'}</td>),
    be: row => (<td className="n r" key="be">{row.be ? pickPrice(row, row.be) : row.beNo && row.v.cost ? (row.maxM > 0 ? <span className="m-no" title="Нужна цена больше чем в 3 раза выше текущей">&gt; 3× цены</span> : <span className="m-no" title={why(row.v, row.maxM)}>ценой не достичь</span>) : '—'}</td>),

    tp: row => { const gap = row.tp ? row.tp - row.r.P : null; return (<td className="n r" key="tp">{row.tp ? <>{pickPrice(row, row.tp)}<small className={`m-sub ${gap > 0 ? 's-down' : 's-up'}`}>{gap > 0 ? 'поднять на ' : 'можно −'}{fmtInt(Math.abs(gap))} ({gap > 0 ? '+' : '−'}{Math.abs(gap / row.r.P * 100).toFixed(0)}%)</small></> : row.tpNo && row.v.cost ? (row.maxM > target ? <span className="m-no">&gt; 3× цены</span> : <span className="m-no" title={why(row.v, row.maxM)}>ценой не достичь<small className="m-sub">макс. {pct1(row.maxM)}</small></span>) : '—'}</td>); },

    rev: row => (<td className="n r" key="rev">{fmtInt(row.rev)}<small className="m-sub">{fmtInt(row.orders)} шт</small></td>),
    set: row => (<td className="r m-setc" key="set">
      <SetInput ed={row.priceEd} value={inputVal(row)} placeholder={fmtInt(setMode === 'client' ? row.curClient : row.curPrice)}
        onCommit={val => setPrice(row.a.o, val)} title={`Новая ${setMode === 'client' ? 'цена клиента' : 'цена реализации'}; пусто — останется текущая`} />
      {row.priceEd ? <small className="m-sub">маржа <b className={row.r.profit < 0 ? 's-down' : row.r.margin < target ? 's-warn' : 's-up'}>{pct1(row.r.margin)}</b> <button type="button" className="m-was" title="Убрать новую цену" onClick={() => setPrice(row.a.o, '')}>↺</button></small> : null}
    </td>),
  };
  const colOn = COL_LIST.filter(([k]) => cols.includes(k)).map(([k]) => k);
  const renderTable = (list, pinnedMode) => (
    <div className="a-scroll">
      <table className="a-t s-slice m-tbl">
        <thead><tr>
          <ThCtl ctl={ctl} k="o" className="" filter={false}>Товар</ThCtl>
          {colOn.map(k => <ThCtl key={k} ctl={ctl} k={k} hint={H[k][1]} filter={k !== 'set'}>{H[k][0]}</ThCtl>)}
        </tr></thead>
        <tbody>
          {(full || pinnedMode ? list : list.slice(0, 150)).map(row => (
            <tr key={row.a.i} className={row.status === 'loss' ? 's-hole' : ''}>
              <td className="m-prod"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{pinnedMode
                ? <button type="button" className="m-pinb" title="Вернуть в общую таблицу" onClick={() => unpin(row.a.o)}>✕</button>
                : <button type="button" className="m-pinb" title="Перенести в набор для репрайсера (вниз)" onClick={() => pin([row.a.o])}>📌</button>}<i className="s-dot" style={{ background: CAT_COLORS[cats.topSlot(row.a.parts[0])] || OTHER }} />
                <span title={`${row.a.n}\n${row.a.cat.split(SEP).join(' › ')}`}><b>{row.a.o}</b><small className="m-sub">{row.a.short} · {row.scheme.toUpperCase()} {pct1(row.v.commission)}</small></span></span></td>
              {colOn.map(k => CELL[k](row))}

            </tr>
          ))}
          {!list.length && <tr><td colSpan={colOn.length + 1} className="muted" style={{ padding: 16 }}>Нет товаров</td></tr>}
        </tbody>
      </table>
      {!pinnedMode && list.length > 150 && <button type="button" className="s-fold" onClick={() => setFull(f => !f)}>{full ? 'Свернуть ▲' : `Показать все ${list.length} ▼`}</button>}
    </div>
  );

  if (error) return <div className="mpui"><div className="a-empty" style={{ padding: 40 }}>Не удалось загрузить: {error}</div></div>;
  if (!data || coefs === null) return <div className="mpui"><div className="a-empty" style={{ textAlign: "center", padding: 60 }}>Загрузка…</div></div>;

  return (
    <div className="mpui sa-page">
      <FinHeader title="Цены и маржа" cats={cats} sel={sel} setSel={setSel} search={search} setSearch={setSearch} grp={grp}>
        <button type="button" className="a-btn" onClick={doRefresh} disabled={refr.busy} title="Забрать свежие цены и комиссии (Google-скрипт выгружает их из Ozon каждые 30 минут)">{refr.busy ? '↻ обновляем…' : '↻ Обновить цены'}</button>
        {refr.msg && <span className="a-hint" style={{ maxWidth: 360 }}>{refr.msg}</span>}
        <label className="a-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>целевая маржа
          <input className="a-input" type="number" min="0" max="80" value={target} onChange={e => setTarget(Math.max(0, Number(e.target.value) || 0))} style={{ width: 60, padding: '4px 8px' }} />%
        </label>
        <label className="sw" title="Выключите, чтобы смотреть цены и маржу без рекламы"><input type="checkbox" checked={withAds} onChange={e => setWithAds(e.target.checked)} /><i />с учётом рекламы</label>
        {withAds && <label className="a-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title="Пусто — у каждого товара его фактический ДРР за 30 дней. Число — один ДРР для всех (кроме заданных вручную в таблице)">ДРР для всех
          <input className="a-input" type="number" min="0" max="100" step="0.5" value={drrAll} placeholder="факт" onChange={e => setDrrAll(e.target.value)} style={{ width: 64, padding: '4px 8px' }} />%
        </label>}
        {(drrAll !== '' || Object.keys(drrOver).length > 0) && <button type="button" className="tt-reset" onClick={() => { setDrrAll(''); setDrrOver({}); }} title="Вернуть фактический ДРР всем товарам">↺ вернуть ДРР</button>}
      </FinHeader>

      <div className="a-kpis s-kpis">
        <Kpi label="Средняя маржа (по заказам)" value={pct1(avgMargin)} sub={`${withCost.length} товаров с себестоимостью · налог ${tax}%`} />
        <Kpi label="Убыточные при текущей цене" value={fmtInt(counts.loss)} sub={`их заказы за 30 дн: ${fmtInt(lossRev)} ₽`} />
        <Kpi label={`Ниже цели ${target}%`} value={fmtInt(counts.below)} sub="прибыль есть, но маржа ниже цели" />
        <Kpi label="Без себестоимости" value={fmtInt(counts.nocost)} sub="заполните во вкладке «Себестоимость»" />
      </div>

      <div className="a-card s-card">
        <div className="i-sigs" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
          {FILTERS.map(([k, l, tone]) => (
            <button key={k} type="button" className={`i-sig ${tone} ${flt === k ? 'on' : ''} ${counts[k] ? '' : 'zero'}`} onClick={() => setFlt(flt === k ? null : k)}>
              <b className="n">{fmtInt(counts[k])}</b><span>{l}</span>
            </button>
          ))}
        </div>
        {(() => {
          // Сколько товаров выбранной категории не попало в таблицу и почему.
          let noOrd = 0, noPrice = 0;
          if (data) { const byArt = new Map(data.a.map(x => [x[0], x])); for (const a of cats.arts) { if (!inPath(a, sel) || !matchQ(a, q) || !grp.test(a)) continue; const x = byArt.get(a.i); if (!x || !x[1]) noPrice++; else if (!(x[13] > 0 || x[25] > 0 || x[24] > 0)) noOrd++; } }
          return (noOrd > 0 || noPrice > 0) ? (
            <div className="a-hint" style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>В таблице {fmtInt(base.length)} товаров{!allArts && noOrd ? ` — только с заказами за 30 дней; ещё ${fmtInt(noOrd)} без заказов скрыты` : ''}{noPrice ? `${!allArts && noOrd ? ',' : ' —'} ${fmtInt(noPrice)} без цены в карточке (не выгружены из Ozon) не показаны` : ''}.</span>
              {noOrd > 0 && <label className="sw"><input type="checkbox" checked={allArts} onChange={e => setAllArts(e.target.checked)} /><i />показать и без заказов</label>}
            </div>) : null;
        })()}
        <div className="a-hint" style={{ marginTop: 8 }}>
          <b>Как считается.</b> Прогноз на одну проданную штуку при текущей цене — по единой модели, той же, что в «Юнит-экономике», «Рекламе» и калькуляторе:
          цена реализации − комиссия (FBO из карточки / FBS по факту, в доле отгрузок) − логистика (прямая на отправку + обратная на возврат, с учётом выкупа за 90 дней)
          − эквайринг и прочее (% от продаж за 30 дней) − реклама (ДРР прогнозный) − себестоимость − налог (от цены клиента).
          «Всего за 30 дн» = на 1 шт × заказы × выкуп — сходится с прогнозом «Юнит-экономики» за 30 дней. «Прибыль факт» — по начислениям Ozon, как в P&L.
        </div>
      </div>

      <div className="a-card">
        <div className="a-bar m-tools">
          <span className="a-seg" title="Денежные колонки (себестоимость, комиссия, логистика, реклама, налог, на счёт, прибыль): на одну проданную штуку или всего за 30 дней (заказы × выкуп)">
            <button type="button" className={per === 'unit' ? 'on' : ''} onClick={() => setPer('unit')}>на 1 шт</button>
            <button type="button" className={per === 'total' ? 'on' : ''} onClick={() => setPer('total')}>всего за 30 дн</button>
          </span>
          <ColPicker cols={cols} setCols={setCols} target={target} />
          <span className="a-seg" title="В какой цене вписывать новую цену и выгружать файл для репрайсера">
            <span className="m-seglbl">новая цена —</span>
            <button type="button" className={setMode === 'client' ? 'on' : ''} onClick={() => setSetMode('client')}>цена клиента</button>
            <button type="button" className={setMode === 'real' ? 'on' : ''} onClick={() => setSetMode('real')}>цена реализации</button>
          </span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {shown.some(r => r.priceEd) && <button type="button" className="a-btn" onClick={() => exportXlsx(shown.filter(r => r.priceEd))} title="Строки таблицы, где вписана новая цена">⬇ Excel: с новой ценой ({shown.filter(r => r.priceEd).length})</button>}
            <button type="button" className="a-btn ghost" onClick={() => exportXlsx(shown)} title="Все строки таблицы с учётом фильтров; где новая цена не вписана — текущая">⬇ все в таблице ({shown.length})</button>
            <button type="button" className="a-btn ghost" onClick={() => pin(shown.map(r => r.a.o))} title="Перенести все показанные строки в набор ниже">📌 все показанные</button>
            {Object.keys(priceOver).length > 0 && <button type="button" className="tt-reset" onClick={() => { if (window.confirm(`Стереть все вписанные новые цены (${Object.keys(priceOver).length})?`)) setPriceOver({}); }}>стереть новые цены ({Object.keys(priceOver).length})</button>}
            <ResetCtl ctl={ctl} />
          </span>
        </div>
        {renderTable(shown)}
      </div>

      <div className="a-card m-pinned">
        <div className="a-bar m-tools">
          <b style={{ fontSize: 14 }}>Набор для репрайсера</b>
          <span className="a-hint" style={{ margin: 0 }}>{pinRows.length ? `${pinRows.length} арт. · новых цен ${pinRows.filter(r => r.priceEd).length}` : 'нажмите 📌 у строки — она перенесётся сюда; так можно собрать цены по разным артикулам и выгрузить одним файлом'}</span>
          {pinRows.length > 0 && <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}>
            <button type="button" className="a-btn" onClick={() => exportXlsx(pinRows)} title="Артикул и новая цена; где не вписана — текущая">⬇ Excel ({pinRows.length})</button>
            <button type="button" className="a-btn ghost" onClick={() => { if (window.confirm('Вернуть все строки из набора в общую таблицу? Вписанные цены сохранятся.')) setPinned([]); }}>вернуть все</button>
            <button type="button" className="a-btn ghost" onClick={() => { if (window.confirm('Очистить набор и стереть вписанные в нём новые цены?')) { setPriceOver(m => { const n = { ...m }; for (const o of pinned) delete n[o]; return n; }); setPinned([]); } }}>очистить</button>
          </span>}
        </div>
        {pinRows.length > 0 && renderTable(pinRows, true)}
      </div>
    </div>
  );
}
