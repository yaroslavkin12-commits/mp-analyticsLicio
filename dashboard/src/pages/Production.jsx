import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import dayjs from 'dayjs';
import {
  getProduction, uploadProduction, saveProductionMaster, saveProductionSettings, saveProductionOrder, removeProductionOrder,
} from '../api';
import { useTableCtl, ThCtl, ResetCtl } from '../components/TableTools';
import { fmtInt } from './AdsStats2';
import { SHOPS, MATERIALS, TOPS, DEFAULT_SETTINGS, calcRow, allocate, taskSizeOf, matOf, buildJournal, J_STATUS } from '../lib/production';
import ProdJournal from './ProdJournal';
import Deflectors2d from './Deflectors2d';
import './ads2.css';
import './sales.css';
import './production.css';

// ─────────────────────────────────────────────────────────────────────────
// «Производство» — потребность в пошив (сейчас — чехлы на сиденья).
// Данные из 1С загружаются файлами: продажи за год (раз в 3 месяца), за 4 и
// 8 недель, остатки ДРЦ и «Пошив» (в работе у цехов) — в день заказа.
// Расчёт — как в файле sales_system (lib/production.js). Заказ в цех
// набирается по приоритету до нужного числа заданий (1 задание = 6 шт
// экокожи или 10 шт жаккарда), по умолчанию — до мощности цеха.
// Подача: понедельник — Гурьевская, четверг — Ельцовка и Искитим.
// ─────────────────────────────────────────────────────────────────────────

const KIND = [
  { k: 'year', t: 'Продажи за год', every: 'раз в 3 месяца', col: 2, maxAge: 100 },
  { k: 'w4', t: 'Продажи 4 недели', every: 'в день заказа', col: 2, maxAge: 1 },
  { k: 'w8', t: 'Продажи 8 недель', every: 'в день заказа', col: 2, maxAge: 1 },
  { k: 'stock', t: 'Остатки (ДРЦ)', every: 'в день заказа', col: 3, maxAge: 1 },
  { k: 'sew', t: 'Пошив (в пути)', every: 'в день заказа', col: 5, maxAge: 1 },
];
const DECISION = { ORDER: 'заказать', PLAN: 'скоро', HOLD: 'хватает', 'NO ORDER': 'не нужно' };
const DEC_CLS = { ORDER: 'b', PLAN: 'w', HOLD: 'g', 'NO ORDER': 'm' };
const SIGNAL = {
  'RAISE +5%': ['поднять +5%', 'up'], 'RAISE +3%': ['поднять +3%', 'up'], 'KEEP PRICE': ['держать', ''],
  'DROP -3%': ['снизить −3%', 'dn'], 'DROP -5%': ['снизить −5%', 'dn'], 'REVIEW SKU': ['пересмотреть', 'warn'],
};
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const num1 = v => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(v < 10 ? 2 : 1).replace('.', ','));
const ld = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch (e) { return d; } };
const sv = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };

// Строки файла 1С: артикул в 1-й колонке, количество — в колонке col (иначе последнее число в строке).
function parseSheet(aoa, col) {
  const items = {};
  for (const r of aoa) {
    const o = String(r[0] ?? '').trim(); if (!o || /^артикул/i.test(o)) continue;
    let q = typeof r[col] === 'number' ? r[col] : Number(String(r[col] ?? '').replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(q) || r[col] === '' || r[col] === undefined) {
      q = null;
      for (let i = r.length - 1; i >= 1; i--) { const v = typeof r[i] === 'number' ? r[i] : null; if (v !== null) { q = v; break; } }
    }
    if (q === null || !Number.isFinite(q)) continue;
    items[o] = (items[o] || 0) + q;
  }
  return items;
}

export default function Production({ cabinet }) {
  const [tab, setTab] = useState(() => ld('mp-production-tab', 'covers'));
  const pick = value => { setTab(value); sv('mp-production-tab', value); };
  const nav = <span className="a-seg"><button type="button" className={tab !== '2d' ? 'on' : ''} onClick={() => pick('covers')}>Чехлы на сиденья</button><button type="button" className={tab === '2d' ? 'on' : ''} onClick={() => pick('2d')}>Дефлекторы · 2D</button></span>;
  return tab === '2d' ? <Deflectors2d nav={nav} /> : <SeatProduction cabinet={cabinet} nav={nav} />;
}

function SeatProduction({ cabinet, nav }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState('');
  const [selectedOffer, setSelectedOffer] = useState('');
  const journalRef = useRef(null);
  const [expandedOrders, setExpandedOrders] = useState(new Set());
  const load = useCallback(() => getProduction(cabinet).then(r => setD(r.data.data)).catch(e => setErr(e.response?.data?.error || e.message)), [cabinet]);
  useEffect(() => { load(); }, [load]);

  const settings = useMemo(() => ({ ...DEFAULT_SETTINGS, ...(d?.settings || {}), capacity: { ...DEFAULT_SETTINGS.capacity, ...(d?.settings?.capacity || {}) } }), [d]);
  const data = useMemo(() => {
    const u = d?.uploads || {};
    return { year: u.year?.items || {}, w4: u.w4?.items || {}, w8: u.w8?.items || {}, stock: u.stock?.items || {}, sew: u.sew?.items || {} };
  }, [d]);

  // Журнал заявок: открытые заявки и сверка с пошивом 1С.
  const journal = useMemo(() => (d ? buildJournal(d.orders, d.closed, data, d.uploads) : []), [d, data]);
  const jmap = useMemo(() => new Map(journal.filter(r => !r.closed).map(r => [r.o, r])), [journal]);

  // Подача: какие цеха сегодня.
  const today = dayjs();
  const [shopsOn, setShopsOn] = useState(() => DEFAULT_SETTINGS.orderDays[today.day()] || []);
  const [tasks, setTasks] = useState(() => ld(`mp-prod-tasks:${cabinet}:${today.format('YYYY-MM-DD')}`, {}));
  useEffect(() => { sv(`mp-prod-tasks:${cabinet}:${today.format('YYYY-MM-DD')}`, tasks); }, [tasks]); // eslint-disable-line react-hooks/exhaustive-deps
  const [over, setOver] = useState(() => ld(`mp-prod-over:${cabinet}:${today.format('YYYY-MM-DD')}`, {}));
  useEffect(() => { sv(`mp-prod-over:${cabinet}:${today.format('YYYY-MM-DD')}`, over); }, [over]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    if (!d) return [];
    return Object.entries(d.master || {}).map(([o, m]) => {
      const r = { o, ...m, mat: matOf(m.mat, m.n) };
      r.c = calcRow(r, data, settings);
      return r;
    });
  }, [d, data, settings]);

  // Заказ по каждому цеху (по заданиям или мощности), с ручными правками количества.
  const alloc = useMemo(() => {
    const res = {};
    for (const shop of SHOPS) {
      const t = tasks[shop];
      const lim = t !== undefined && t !== '' && t !== null ? { tasks: Number(t), fill: !!tasks[shop + ':fill'] } : { pcs: settings.capacity[shop] };
      const a = allocate(rows.filter(r => r.shop === shop), lim, settings);
      // Ручные правки: вписанное количество заменяет расчётное.
      for (const r of rows) {
        if (r.shop !== shop || over[r.o] === undefined || over[r.o] === '') continue;
        const q = Math.max(0, Number(over[r.o]) || 0);
        if (q > 0) a.map.set(r.o, { qty: q, tasks: q / taskSizeOf(r, settings), manual: true }); else a.map.delete(r.o);
      }
      let pcs = 0, tsk = 0; const byMat = {};
      for (const [o, v] of a.map) {
        const r = rows.find(x => x.o === o); const m = r?.mat || '—';
        pcs += v.qty; tsk += Math.ceil(v.tasks - 1e-9);
        byMat[m] = byMat[m] || { pcs: 0, tasks: 0 }; byMat[m].pcs += v.qty; byMat[m].tasks += Math.ceil(v.tasks - 1e-9);
      }
      const need = rows.filter(r => r.shop === shop && r.c.W > 0);
      res[shop] = { map: a.map, pcs, tasks: tsk, byMat, lim, left: a.left.filter(x => over[x.r.o] === undefined || over[x.r.o] === ''), added: a.added, needPcs: need.reduce((s, r) => s + r.c.W, 0), needTasks: need.reduce((s, r) => s + Math.ceil(r.c.W / taskSizeOf(r, settings) - 1e-9), 0) };
    }
    return res;
  }, [rows, tasks, over, settings]);

  // Есть в загрузках 1С (продажи), нет в справочнике.
  const missing = useMemo(() => {
    if (!d) return [];
    const m = d.master || {};
    return [...new Set([...Object.keys(data.w4), ...Object.keys(data.year)])].filter(o => !m[o] && /^\S+$/.test(o) && (data.w4[o] > 0 || data.year[o] > 0));
  }, [d, data]);

  // ── Загрузки ──
  async function onFile(kind, e) {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    setMsg(null); setBusy(kind);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await f.arrayBuffer());
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
      const k = KIND.find(x => x.k === kind);
      const items = parseSheet(aoa, k.col);
      const n = Object.keys(items).length, tot = Object.values(items).reduce((s, v) => s + v, 0);
      if (!n) { setMsg({ bad: true, text: `В файле «${f.name}» не нашёл строк «артикул — количество».` }); return; }
      const known = Object.keys(items).filter(o => d.master?.[o]).length;
      if (!window.confirm(`${k.t}: ${n} арт., всего ${fmtInt(tot)} шт (из справочника — ${known}). Загрузить? Прежние данные заменятся.`)) return;
      await uploadProduction(cabinet, kind, items, f.name);
      setMsg({ text: `${k.t}: загружено ${n} арт., ${fmtInt(tot)} шт.` });
      await load();
    } catch (x) { setMsg({ bad: true, text: 'Не удалось прочитать файл: ' + x.message }); } finally { setBusy(''); }
  }
  // Справочник из файла sales_system (лист DASHBOARD): авто, артикул, наименование, цех, материал,
  // продажи за год (если вписаны руками — это ручное значение для новинок), цикл, буфер, партия, TOP.
  async function onMaster(e) {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    setMsg(null); setBusy('master');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await f.arrayBuffer(), { cellFormula: true });
      const ws = wb.Sheets.DASHBOARD || wb.Sheets[wb.SheetNames[0]];
      const range = XLSX.utils.decode_range(ws['!ref']);
      const cell = (r, c) => ws[XLSX.utils.encode_cell({ r, c })];
      const val = (r, c) => cell(r, c)?.v;
      // Шапка: строка, где есть «Артикул».
      let h = -1;
      for (let r = 0; r <= Math.min(range.e.r, 10) && h < 0; r++) for (let c = 0; c <= 6; c++) if (/^артикул/i.test(String(val(r, c) || ''))) { h = r; break; }
      if (h < 0) { setMsg({ bad: true, text: 'Не нашёл шапку с колонкой «Артикул» на листе DASHBOARD.' }); return; }
      const head = []; for (let c = 0; c <= range.e.c; c++) head[c] = String(val(h, c) || '').trim().toLowerCase();
      const ci = re => head.findIndex(x => re.test(x));
      const C = { car: ci(/^авто/), o: ci(/^артикул/), n: ci(/^наименование/), shop: ci(/^цех/), mat: ci(/^материал/), year: ci(/^продажи год/), cycle: ci(/^цикл/), buffer: ci(/^буфер/), batch: ci(/^партия/), top: ci(/^top уровень$/) };
      const items = {};
      for (let r = h + 1; r <= range.e.r; r++) {
        const o = String(val(r, C.o) ?? '').trim(); if (!o) continue;
        const yc = C.year >= 0 ? cell(r, C.year) : null;
        items[o] = {
          car: C.car >= 0 ? String(val(r, C.car) ?? '') : '', n: C.n >= 0 ? String(val(r, C.n) ?? '') : '',
          shop: C.shop >= 0 ? String(val(r, C.shop) ?? '') : '', mat: C.mat >= 0 ? String(val(r, C.mat) ?? '') : '',
          cycle: Number(val(r, C.cycle)) || 21, buffer: Number(val(r, C.buffer)) || 21, batch: Number(val(r, C.batch)) || 10,
          top: C.top >= 0 ? String(val(r, C.top) ?? 'ХВОСТ') : 'ХВОСТ',
          yearOv: yc && !yc.f && typeof yc.v === 'number' ? yc.v : null,
        };
      }
      const n = Object.keys(items).length;
      if (!n) { setMsg({ bad: true, text: 'Строк с артикулами не нашёл.' }); return; }
      if (!window.confirm(`Справочник: ${n} артикулов (цех, материал, цикл, буфер, партия, TOP). Заменить текущий?`)) return;
      await saveProductionMaster(cabinet, items, true);
      setMsg({ text: `Справочник загружен: ${n} артикулов.` });
      await load();
    } catch (x) { setMsg({ bad: true, text: 'Не удалось прочитать файл: ' + x.message }); } finally { setBusy(''); }
  }
  const editMaster = (o, patch) => {
    setD(prev => ({ ...prev, master: { ...prev.master, [o]: { ...prev.master[o], ...patch } } }));
    saveProductionMaster(cabinet, { [o]: patch }).catch(() => setMsg({ bad: true, text: 'Не удалось сохранить справочник' }));
  };
  const setCapacity = (shop, v) => {
    const s = { ...(d.settings || {}), capacity: { ...settings.capacity, [shop]: Number(v) || 0 } };
    setD(prev => ({ ...prev, settings: s }));
    saveProductionSettings(cabinet, s).catch(() => {});
  };

  // ── Заказ: выгрузка и фиксация ──
  const orderRows = shop => [...alloc[shop].map.entries()].map(([o, v]) => ({ r: rows.find(x => x.o === o), ...v }))
    .filter(x => x.r).sort((a, b) => b.r.c.Y - a.r.c.Y);
  // Выгрузка: отдельный файл на каждый цех — «Потребность <цех> <дата>.xlsx».
  async function exportOrder() {
    const XLSX = await import('xlsx');
    for (const shop of shopsOn) {
      const aoa = [['Артикул', 'Наименование', 'Цех', 'Материал', 'Кол-во, шт', 'Кол-во заданий']];
      orderRows(shop).forEach(x => aoa.push([x.r.o, x.r.n, shop, x.r.mat, x.qty, Math.round(x.tasks * 10) / 10]));
      const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = [{ wch: 16 }, { wch: 80 }, { wch: 12 }, { wch: 10 }, { wch: 11 }, { wch: 14 }];
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, shop.slice(0, 30));
      XLSX.writeFile(wb, `Потребность ${shop} ${today.format('DD.MM.YYYY')}.xlsx`);
    }
  }
  async function fixOrder() {
    if (!shopsOn.length) return;
    if (!window.confirm(`Зафиксировать заказ ${today.format('DD.MM')}: ${shopsOn.map(s => `${s} — ${alloc[s].tasks} зад., ${alloc[s].pcs} шт`).join('; ')}?`)) return;
    setBusy('fix');
    try {
      let list = null;
      for (const shop of shopsOn) {
        const r = await saveProductionOrder(cabinet, { date: today.format('YYYY-MM-DD'), shop, tasks: alloc[shop].tasks, pcs: alloc[shop].pcs, items: orderRows(shop).map(x => [x.r.o, x.qty, Math.round(x.tasks * 10) / 10, x.r.c.sew, x.r.c.stock, x.fill || 0]) });
        list = r.data.data;
      }
      setD(prev => ({ ...prev, orders: list }));
      setMsg({ text: 'Заказ сохранён в истории.' });
    } catch (x) { setMsg({ bad: true, text: x.message }); } finally { setBusy(''); }
  }
  async function downloadPast(o) {
    const XLSX = await import('xlsx');
    const aoa = [['Артикул', 'Наименование', 'Кол-во, шт', 'Заданий'], ...o.items.filter(r => !selectedOffer || r[0] === selectedOffer).map(([a, q, t]) => [a, d.master?.[a]?.n || '', q, t])];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), o.shop.slice(0, 30));
    XLSX.writeFile(wb, `Заказ ${o.shop} ${dayjs(o.date).format('DD.MM.YYYY')}.xlsx`);
  }

  // ── Таблица ──
  const [fShop, setFShop] = useState('');
  const [fDec, setFDec] = useState('');
  const [fMat, setFMat] = useState('');
  const [onlyOrder, setOnlyOrder] = useState(false);
  const [onlyFocus, setOnlyFocus] = useState(false);
  const [onlyFill, setOnlyFill] = useState(false);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(false);
  const ctl = useTableCtl(`prod-${cabinet}`, { k: 'pr', dir: -1 });
  const inOrder = o => { for (const s of SHOPS) { const v = alloc[s]?.map.get(o); if (v) return v; } return null; };
  const list = useMemo(() => rows.filter(r => (!fShop || r.shop === fShop) && (!fDec || r.c.V === fDec) && (!fMat || r.mat === fMat)
    && (!onlyOrder || inOrder(r.o)) && (!onlyFocus || r.focus) && (!onlyFill || inOrder(r.o)?.fill) && (!q || r.o.toLowerCase().includes(q.toLowerCase()) || String(r.n || '').toLowerCase().includes(q.toLowerCase()))),
  [rows, fShop, fDec, fMat, onlyOrder, onlyFocus, onlyFill, q, alloc]); // eslint-disable-line react-hooks/exhaustive-deps
  const GET = {
    o: r => r.o, shop: r => r.shop, mat: r => r.mat, top: r => r.top, year: r => r.c.year, w4: r => r.c.w4, w8: r => r.c.w8, stock: r => r.c.stock, sew: r => r.c.sew,
    p: r => r.c.P, trend: r => r.c.Q, s: r => r.c.S, cov: r => r.c.T, dec: r => ['ORDER', 'PLAN', 'HOLD', 'NO ORDER'].indexOf(r.c.V), w: r => r.c.W, pr: r => r.c.Y,
    fin: r => inOrder(r.o)?.qty ?? 0, sig: r => r.c.U,
  };
  const shown = ctl.apply(list, (r, k) => (GET[k] ? GET[k](r) : null));
  const [full, setFull] = useState(false);
  const vis = full ? shown : shown.slice(0, 60);
  const decCount = k => rows.filter(r => (!fShop || r.shop === fShop) && r.c.V === k).length;

  if (err && !d) return <div className="mpui"><div className="a-empty" style={{ padding: 40 }}>Не удалось загрузить: {err}</div></div>;
  if (!d) return <div className="mpui"><div className="a-empty" style={{ padding: 40, textAlign: 'center' }}>Загрузка…</div></div>;
  const masterN = Object.keys(d.master || {}).length;
  const ageDays = at => (at ? dayjs().startOf('day').diff(dayjs(at).startOf('day'), 'day') : null);

  return (
    <div className="mpui">
      <div className="page-sticky">
        <div className="a-top">
          <h1>Производство</h1>
          {nav}

          <span className="a-hint" style={{ margin: 0 }}>подача: пн — Гурьевская, чт — Ельцовка и Искитим</span>
        </div>
      </div>

      {msg && <div className={`c-msg ${msg.bad ? 'bad' : ''}`} style={{ margin: '10px 0' }}>{msg.text}</div>}

      {/* Данные из 1С */}
      <div className="a-card pr-card">
        <div className="a-bar" style={{ marginBottom: 8 }}><b style={{ fontSize: 14 }}>Данные из 1С</b>
          <span className="a-hint" style={{ margin: 0 }}>файл Excel: артикул в первой колонке, количество — как в выгрузке 1С; новая загрузка заменяет прежнюю</span></div>
        <div className="pr-up">
          {KIND.map(k => {
            const u = d.uploads?.[k.k]; const n = u ? Object.keys(u.items || {}).length : 0; const age = ageDays(u?.at);
            const stale = age === null || age >= k.maxAge;
            return (
              <div key={k.k} className={`pr-upc ${!u?.at ? 'none' : stale ? 'stale' : 'ok'}`}>
                <div className="pr-upt">{k.t}</div>
                <div className="pr-upe">{k.every}</div>
                <div className="pr-ups">{u?.at ? <>{dayjs(u.at).format('DD.MM HH:mm')} · {n} арт.{age > 0 ? <span> · {age} дн назад</span> : null}</> : 'не загружено'}</div>
                <label className="a-btn ghost pr-upb">{busy === k.k ? 'загружаю…' : 'Загрузить'}<input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => onFile(k.k, e)} /></label>
              </div>
            );
          })}
          <div className={`pr-upc ${masterN ? 'ok' : 'none'}`}>
            <div className="pr-upt">Справочник</div>
            <div className="pr-upe">цех, материал, цикл, буфер, партия, TOP</div>
            <div className="pr-ups">{masterN ? `${masterN} артикулов` : 'не загружен'}</div>
            <label className="a-btn ghost pr-upb" title="Файл sales_system — лист DASHBOARD">{busy === 'master' ? 'загружаю…' : 'Из sales_system'}<input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={onMaster} /></label>
          </div>
        </div>
        {missing.length > 0 && <div className="a-hint" style={{ marginTop: 8 }}>Продаются по 1С, но нет в справочнике ({missing.length}): {missing.slice(0, 12).join(', ')}{missing.length > 12 ? '…' : ''} — добавьте в файл sales_system и загрузите справочник заново.</div>}
      </div>

      {/* Заказ в цеха */}
      <div className="a-card pr-card">
        <div className="a-bar" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
          <b style={{ fontSize: 14 }}>Заказ в цех · {today.format('DD.MM.YYYY')}, {WD[today.day()]}</b>
          <span className="a-seg">
            {SHOPS.map(s => <button key={s} type="button" className={shopsOn.includes(s) ? 'on' : ''} onClick={() => setShopsOn(v => (v.includes(s) ? v.filter(x => x !== s) : [...v, s]))}>{s}</button>)}
          </span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}>
            <button type="button" className="a-btn ghost" disabled={!shopsOn.length} onClick={exportOrder}>⬇ Заказ в Excel</button>
            <button type="button" className="a-btn" disabled={!shopsOn.length || busy === 'fix'} onClick={fixOrder} title="Сохранить заказ в истории">Зафиксировать заказ</button>
          </span>
        </div>
        <div className="pr-shops">
          {SHOPS.map(s => {
            const a = alloc[s]; const on = shopsOn.includes(s);
            const cap = settings.capacity[s];
            return (
              <div key={s} className={`pr-shop ${on ? 'on' : ''}`}>
                <div className="pr-shopt">{s}</div>
                <label className="pr-in">Нужно заданий
                  <input className="a-input" type="number" min="0" value={tasks[s] ?? ''} placeholder={`мощность ${cap} шт`} onChange={e => setTasks(t => ({ ...t, [s]: e.target.value }))} />
                </label>
                <div className="pr-res"><b>{a.tasks}</b> заданий · <b>{fmtInt(a.pcs)}</b> шт</div>
                <div className="pr-sub">
                  {Object.entries(a.byMat).map(([m, v]) => <span key={m}>{m}: {v.pcs} шт / {v.tasks} зад.</span>)}
                </div>
                <div className="pr-sub muted">потребность: {a.needTasks} зад., {fmtInt(a.needPcs)} шт{a.lim.tasks !== undefined && a.needTasks < a.lim.tasks ? ' — меньше, чем просит цех' : ''}</div>
                {a.lim.tasks !== undefined && a.needTasks < a.lim.tasks && (
                  <button type="button" className="a-toggle pr-fill" onClick={() => setTasks(t => ({ ...t, [s + ':fill']: !t[s + ':fill'] }))}
                    title="Добрать задания до нужного числа: по одному заданию артикулам, у которых после заказа меньше всего дней запаса (до 90 дней)">
                    <span className={`a-sw ${tasks[s + ':fill'] ? 'on' : ''}`} />добрать до {a.lim.tasks} заданий{a.added?.size ? ` (добрано ${[...a.added.values()].reduce((x, y) => x + y, 0)} шт)` : ''}
                  </button>
                )}
                {a.left.length > 0 && (
                  <details className="pr-left">
                    <summary>Не вошло: {a.left.reduce((x, y) => x + y.tasks, 0)} зад. по {a.left.length} арт.</summary>
                    {a.left.slice(0, 15).map(x => (
                      <div key={x.r.o} className="pr-leftr">
                        <span><b>{x.r.o}</b> — {x.qty} шт ({x.tasks} зад.){x.r.focus ? ' ★' : ''}</span>
                        <button type="button" className="a-btn ghost" title="Добавить в заказ всю потребность артикула" onClick={() => setOver(v => ({ ...v, [x.r.o]: String((a.map.get(x.r.o)?.qty || 0) + x.qty) }))}>+ в заказ</button>
                      </div>
                    ))}
                    {a.left.length > 15 && <div className="muted">…и ещё {a.left.length - 15}</div>}
                  </details>
                )}
                <label className="pr-in sm">Мощность, шт/нед
                  <input className="a-input" type="number" min="0" value={cap} onChange={e => setCapacity(s, e.target.value)} />
                </label>
              </div>
            );
          })}
        </div>
      </div>

      {/* Таблица */}
      <div className="a-card pr-card">
        <div className="a-bar" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <b style={{ fontSize: 14 }}>Потребность по артикулам</b>
          <span className="a-seg">
            <button type="button" className={!fShop ? 'on' : ''} onClick={() => setFShop('')}>Все цеха</button>
            {[...SHOPS, 'выводим'].map(s => <button key={s} type="button" className={fShop === s ? 'on' : ''} onClick={() => setFShop(s)}>{s}</button>)}
          </span>
          <span className="a-seg">
            <button type="button" className={!fMat ? 'on' : ''} onClick={() => setFMat('')}>Все</button>
            {MATERIALS.map(m => <button key={m} type="button" className={fMat === m ? 'on' : ''} onClick={() => setFMat(m)}>{m}</button>)}
          </span>
        </div>
        <div className="a-bar" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          {['ORDER', 'PLAN', 'HOLD', 'NO ORDER'].map(k => (
            <button key={k} type="button" className={`s-chip ${fDec === k ? 'on' : ''}`} onClick={() => setFDec(v => (v === k ? '' : k))}>{DECISION[k]} <b className="n">{decCount(k)}</b></button>
          ))}
          <button type="button" className="a-toggle" onClick={() => setOnlyOrder(v => !v)}><span className={`a-sw ${onlyOrder ? 'on' : ''}`} />Только в заказе</button>
          <button type="button" className={`s-chip ${onlyFocus ? 'on' : ''}`} onClick={() => setOnlyFocus(v => !v)} title="Артикулы, отмеченные звёздочкой: тестируем в рекламе или готовим к ней">★ под рекламу <b className="n">{rows.filter(r => r.focus).length}</b></button>
          {(() => { const n = rows.filter(r => inOrder(r.o)?.fill && (!fShop || r.shop === fShop)).length; return n || onlyFill ? (
            <button type="button" className={`s-chip ${onlyFill ? 'on' : ''}`} onClick={() => setOnlyFill(v => !v)} title="Артикулы, добавленные сверх потребности, чтобы добрать цех до нужного числа заданий">⊕ добор <b className="n">{n}</b></button>) : null; })()}
          <button type="button" className="a-toggle" onClick={() => setEdit(v => !v)} title="Править цех, материал, цикл, буфер, партию, TOP и продажи за год (для новинок)"><span className={`a-sw ${edit ? 'on' : ''}`} />Править справочник</button>
          <input className="a-input" placeholder="Артикул или название" value={q} onChange={e => setQ(e.target.value)} style={{ minWidth: 220 }} />
          <ResetCtl ctl={ctl} style={{ marginLeft: 'auto' }} />
        </div>
        <div className="a-scroll">
          <table className="a-t pr-t">
            <thead><tr>
              <ThCtl ctl={ctl} k="o" className="" filter={false}>Артикул</ThCtl>
              <ThCtl ctl={ctl} k="shop" className="" filter={false}>Цех</ThCtl>
              <ThCtl ctl={ctl} k="top" className="" filter={false}>TOP</ThCtl>
              <ThCtl ctl={ctl} k="year" hint="Продажи за год (из 1С); у новинок — вписанное вручную значение">Год</ThCtl>
              <ThCtl ctl={ctl} k="w4">4 нед</ThCtl>
              <ThCtl ctl={ctl} k="w8">8 нед</ThCtl>
              <ThCtl ctl={ctl} k="stock" hint="Остаток на складах (ДРЦ)">Остаток</ThCtl>
              <ThCtl ctl={ctl} k="sew" hint="В пошиве у цехов; в покрытии и заказе учитывается наполовину">В пути</ThCtl>
              <ThCtl ctl={ctl} k="p" hint="Продажи в день: 0,6 × средние за год + 0,4 × средние за 4 недели">В день</ThCtl>
              <ThCtl ctl={ctl} k="trend" hint="Продажи 4 недель к среднему за год: больше 1 — растут">Тренд</ThCtl>
              <ThCtl ctl={ctl} k="s" hint="Сколько держать: продажи в день × (цикл + буфер) × поправка на тренд">Цел. запас</ThCtl>
              <ThCtl ctl={ctl} k="cov" hint="На сколько дней хватит остатка и половины «в пути»">Покрытие, дн</ThCtl>
              <ThCtl ctl={ctl} k="dec" filter={false} hint="< 28 дн — заказать; < 35 — скоро; ≤ 45 — хватает; больше — не нужно">Решение</ThCtl>
              <ThCtl ctl={ctl} k="w" hint="Целевой запас − остаток − половина «в пути», округлено до партии">Потребность</ThCtl>
              <ThCtl ctl={ctl} k="pr" hint="Чем меньше покрытие, больше продаж, лучше тренд и выше TOP — тем раньше в заказ">Приоритет</ThCtl>
              <ThCtl ctl={ctl} k="fin" hint="Сколько идёт в заказ с учётом заданий/мощности цеха. Можно вписать своё">В заказ</ThCtl>
              <ThCtl ctl={ctl} k="sig" filter={false} hint="Стартовый сигнал цены из файла: по покрытию и тренду">Цена</ThCtl>
            </tr></thead>
            <tbody>
              {!vis.length && <tr><td colSpan={17} className="muted" style={{ padding: 14 }}>{masterN ? 'Ничего не подходит под фильтр' : 'Загрузите справочник из файла sales_system и данные из 1С'}</td></tr>}
              {vis.map(r => {
                const c = r.c, io = inOrder(r.o), sg = SIGNAL[c.U] || [c.U, ''];
                return (
                  <tr key={r.o} className={`${io ? 'pr-in-order' : ''} ${io?.fill ? 'pr-fill-row' : ''}`}>
                    <td><div className="a-art">
                      <button type="button" className={`pr-star ${r.focus ? 'on' : ''}`} onClick={() => editMaster(r.o, { focus: !r.focus })}
                        title={r.focus ? `Под рекламу: прогноз продаж × ${r.focusK || 1.5}${r.focusMin ? `, не меньше ${r.focusMin} в день` : ''}, приоритет +800. Нажмите, чтобы снять` : 'Отметить «под рекламу»: ждём рост продаж — подсорт заранее и выше в очереди'}>★</button>
                      <div style={{ minWidth: 0 }}><button type="button" className="a-btn ghost" aria-pressed={selectedOffer === r.o} onClick={() => setSelectedOffer(v => v === r.o ? '' : r.o)}>{r.o}</button><div className="model" title={r.n}>{r.car || r.n}</div>
                        {r.focus && edit && <div className="pr-edrow">
                          <label title="Во сколько раз ждём рост продаж">×<input className="a-input pr-num" type="number" step="0.1" defaultValue={r.focusK || 1.5} onBlur={e => editMaster(r.o, { focusK: Number(e.target.value) || 1.5 })} /></label>
                          <label title="Не меньше столько продаж в день (для новинок без истории)">мин/день<input className="a-input pr-num" type="number" step="0.1" defaultValue={r.focusMin ?? ''} onBlur={e => editMaster(r.o, { focusMin: e.target.value === '' ? null : Number(e.target.value) })} /></label>
                        </div>}
                      </div></div></td>
                    <td className="pr-l">{edit ? (
                      <select className="a-input pr-sel" value={r.shop || ''} onChange={e => editMaster(r.o, { shop: e.target.value })}>
                        {[...SHOPS, 'выводим', ''].map(s => <option key={s} value={s}>{s || '—'}</option>)}
                      </select>) : <>{r.shop}<small className="pr-sub2">{r.mat}{edit ? '' : <> · {Number(r.batch) % taskSizeOf(r, settings) ? <b className="s-down" title={`Партия не кратна заданию: 1 задание ${matOf(r.mat, r.n)} = ${taskSizeOf(r, settings)} шт. Поправьте в режиме «Править справочник»`}>партия {r.batch} ≠ задание {taskSizeOf(r, settings)}</b> : `партия ${r.batch}`}</>}</small></>}
                      {edit && <div className="pr-edrow">
                        <select className="a-input pr-sel" value={r.mat} onChange={e => editMaster(r.o, { mat: e.target.value })}>{MATERIALS.map(m => <option key={m}>{m}</option>)}</select>
                        <label title="Цикл производства, дней">ц<input className="a-input pr-num" type="number" defaultValue={r.cycle} onBlur={e => editMaster(r.o, { cycle: Number(e.target.value) || 21 })} /></label>
                        <label title="Буфер, дней">б<input className="a-input pr-num" type="number" defaultValue={r.buffer} onBlur={e => editMaster(r.o, { buffer: Number(e.target.value) || 21 })} /></label>
                        <label title="Партия, шт">п<input className="a-input pr-num" type="number" defaultValue={r.batch} onBlur={e => editMaster(r.o, { batch: Number(e.target.value) || 10 })} /></label>
                      </div>}
                    </td>
                    <td className="pr-l">{edit ? (
                      <select className="a-input pr-sel" value={r.top || 'ХВОСТ'} onChange={e => editMaster(r.o, { top: e.target.value })}>{TOPS.map(t => <option key={t}>{t}</option>)}</select>
                    ) : <span className={`pr-top ${/TOP 10|TOP 20/.test(r.top || '') ? 'hi' : ''}`}>{r.top || '—'}</span>}</td>
                    <td className="n r">{edit ? <input className="a-input pr-num" type="number" placeholder={String(data.year[r.o] ?? 0)} defaultValue={r.yearOv ?? ''} title="Вписать продажи за год вручную (для новинок); пусто — из 1С" onBlur={e => editMaster(r.o, { yearOv: e.target.value === '' ? null : Number(e.target.value) })} />
                      : <>{fmtInt(c.year)}{r.yearOv !== null && r.yearOv !== undefined && r.yearOv !== '' ? <small className="pr-sub2" title="Вписано вручную">вручную</small> : null}</>}</td>
                    <td className="n r">{fmtInt(c.w4)}</td>
                    <td className="n r">{fmtInt(c.w8)}</td>
                    <td className="n r">{fmtInt(c.stock)}</td>
                    <td className="n r">{c.sew ? fmtInt(c.sew) : '—'}</td>
                    <td className="n r">{num1(c.P)}{r.focus && c.base !== c.P ? <small className="pr-sub2" title="Без поправки на рекламу">было {num1(c.base)}</small> : null}</td>
                    <td className="n r"><span className={c.Q === null ? '' : c.Q > 1.2 ? 's-up' : c.Q < 0.8 ? 's-down' : ''}>{c.Q === null ? '—' : num1(c.Q)}</span></td>
                    <td className="n r">{fmtInt(c.S)}</td>
                    <td className="n r">{c.T === null ? '—' : fmtInt(c.T)}</td>
                    <td><span className={`pill ${DEC_CLS[c.V]}`}>{DECISION[c.V]}</span></td>
                    <td className="n r">{c.W ? <>{c.W}<small className="pr-sub2">{Math.ceil(c.W / taskSizeOf(r, settings) - 1e-9)} зад.</small></> : '—'}</td>
                    <td className="n r">{fmtInt(c.Y)}</td>
                    <td className="n r">
                      {SHOPS.includes(r.shop) ? <input className={`a-input pr-num ${over[r.o] !== undefined && over[r.o] !== '' ? 'manual' : ''}`} type="number" min="0" value={over[r.o] ?? ''} placeholder={io ? String(io.qty) : '0'}
                        onChange={e => setOver(v => ({ ...v, [r.o]: e.target.value }))} title="Пусто — по расчёту; впишите своё количество" /> : '—'}
                      {io && <small className="pr-sub2">{Math.round(io.tasks * 10) / 10} зад.</small>}
                      {jmap.get(r.o) && (() => { const j = jmap.get(r.o), js = J_STATUS[j.st] || ['', '']; return (
                        <small className={`pr-sub2 pr-sig ${js[1]}`} title={`Открытые заявки: ${j.lines.map(l => `${dayjs(l.date).format('DD.MM')} — ${l.qty} шт`).join(', ')}. Пошив при заявке ${j.sew0 ?? '—'}, сейчас ${j.sewNow}. Подробнее — в журнале заявок ниже`}>
                          заявка {dayjs(j.first.date).format('DD.MM')}: {j.qty} шт · {js[0]}</small>); })()}
                      {io?.fill ? <small className="pr-sub2 pr-fillb" title={`Добрано до числа заданий: потребность ${c.W} шт, добор +${io.fill} шт`}>добор +{io.fill}</small> : null}
                    </td>
                    <td><span className={`pr-sig ${sg[1]}`}>{sg[0]}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {shown.length > 60 && <button type="button" className="s-fold" onClick={() => setFull(f => !f)}>{full ? 'Свернуть ▲' : `Показать все ${shown.length} ▼`}</button>}
      </div>

      {selectedOffer && <div className="a-bar"><b>{selectedOffer}</b><button className="a-btn ghost" onClick={() => journalRef.current?.scrollIntoView({behavior:'smooth',block:'start'})}>Журнал артикула</button><button className="a-btn ghost" onClick={() => setSelectedOffer('')}>Снять выбор</button></div>}
      <div ref={journalRef} style={{scrollMarginTop:75}}>
      {selectedOffer && <div className="a-bar"><b>{selectedOffer}</b><button className="a-btn ghost" onClick={() => setSelectedOffer('')}>Все артикулы</button></div>}
      <ProdJournal cabinet={cabinet} journal={selectedOffer ? journal.filter(r => r.o === selectedOffer) : journal} master={d.master} setD={setD} setMsg={setMsg} />

      {/* История */}
      {(d.orders || []).length > 0 && (
        <div className="a-card pr-card">
          <div className="a-bar" style={{ marginBottom: 8 }}><b style={{ fontSize: 14 }}>Поданные заказы</b></div>
          <table className="a-t s-slice">
            <thead><tr><th>Дата</th><th>Цех</th><th className="r">Заданий</th><th className="r">Штук</th><th className="r">Артикулов</th><th /></tr></thead>
            <tbody>
              {d.orders.filter(o => !selectedOffer || o.items.some(r => r[0] === selectedOffer)).map(o => ({ ...o, items: o.items.filter(r => !selectedOffer || r[0] === selectedOffer) })).map(o => (
                <React.Fragment key={o.id}><tr>
                  <td><button className="a-btn ghost" aria-expanded={expandedOrders.has(o.id)} onClick={() => setExpandedOrders(v => { const n = new Set(v); n.has(o.id) ? n.delete(o.id) : n.add(o.id); return n; })}>{expandedOrders.has(o.id) ? '▾' : '▸'} {dayjs(o.date).format('DD.MM.YYYY')}, {WD[dayjs(o.date).day()]}</button></td><td>{o.shop}</td>
                  <td className="n r">{selectedOffer ? fmtInt(o.items.reduce((n,r) => n + Number(r[2] || 0), 0)) : o.tasks}</td><td className="n r">{fmtInt(selectedOffer ? o.items.reduce((n,r) => n + r[1], 0) : o.pcs)}</td><td className="n r">{o.items.length}</td>
                  <td className="r">
                    <button type="button" className="a-btn ghost" onClick={() => downloadPast(o)}>⬇ Excel</button>{' '}
                    <button type="button" className="a-btn ghost" onClick={() => { if (window.confirm('Удалить заказ из истории?')) removeProductionOrder(cabinet, o.id).then(r => setD(p => ({ ...p, orders: r.data.data }))); }}>×</button>
                  </td>
                </tr>{expandedOrders.has(o.id) && <tr><td colSpan={6}><table className="a-t no-sh"><thead><tr><th>Артикул</th><th>Название</th><th>Штук</th><th>Заданий</th></tr></thead><tbody>{o.items.filter(r => !selectedOffer || r[0] === selectedOffer).map(([art,qty,tasks]) => <tr key={art}><td>{art}</td><td>{d.master?.[art]?.n || ''}</td><td>{fmtInt(qty)}</td><td>{tasks}</td></tr>)}</tbody></table></td></tr>}</React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </div>
    </div>
  );
}
