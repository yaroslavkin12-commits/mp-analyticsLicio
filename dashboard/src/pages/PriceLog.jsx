import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import { getPriceLog, uploadPriceLog, deletePriceLog, markPriceLog, getSalesData, getCalcBase } from '../api';
import { useTableCtl, ThCtl, ResetCtl } from '../components/TableTools';
import { fmtInt } from './AdsStats2';
import './ads2.css';
import './sales.css';
import './production.css';

// ─────────────────────────────────────────────────────────────────────────
// «Журнал цен» — что меняли в репрайсере и что из этого вышло.
// Раз в неделю (по средам) загружается таблица «артикул → цена для клиента»
// (сейчас Ozon, магазин «Дефлай»). Сервис сравнивает её с прошлой неделей:
// сводка изменений (кому подняли/снизили, на сколько), цели и заметки по
// артикулам, и результат — заказы Ozon за 7 дней до изменения и после.
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

// Группа изменения: круглая сумма (кратная 100 ₽) — «−500 ₽», иначе процент с шагом 0,5.
function groupOf(oldP, newP) {
  const d = newP - oldP, pct = (newP / oldP - 1) * 100;
  if (Math.abs(d) < 0.5) return null;
  if (Math.abs(d) >= 100 && Math.abs(d - Math.round(d / 100) * 100) < 1) return { key: `r${Math.round(d)}`, label: drub(Math.round(d)), sort: d };
  const p = Math.round(pct * 2) / 2;
  if (p === 0) return { key: 'p0', label: 'меньше 0,5%', sort: 0 };
  return { key: `p${p}`, label: `${p > 0 ? '+' : '−'}${Math.abs(p).toString().replace('.', ',')}%`, sort: p * 100 };
}

// Файл репрайсера: строка с «Дефлай» — шапка магазинов, артикул в 1-й колонке.
function parsePrices(aoa) {
  let col = 1, start = 0;
  for (let r = 0; r < Math.min(aoa.length, 6); r++) {
    const i = aoa[r].findIndex(c => /дефлай|defly/i.test(String(c)));
    if (i > 0) { col = i; start = r + 1; break; }
  }
  const items = {};
  for (let r = start; r < aoa.length; r++) {
    const o = String(aoa[r][0] ?? '').trim(); if (!o || /^артикул/i.test(o)) continue;
    const v = aoa[r][col]; const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(n) && n > 0) items[o] = n;
  }
  return items;
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

export default function PriceLog({ cabinet }) {
  const platform = 'ozon';
  const [log, setLog] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState(null);
  const [sel, setSel] = useState(null); // id недели
  const [sales, setSales] = useState(null);
  const [site, setSite] = useState(null);
  const [upDate, setUpDate] = useState(() => dayjs().format('YYYY-MM-DD'));

  const load = useCallback(() => getPriceLog(cabinet, platform).then(r => { setLog(r.data.data); return r.data.data; }).catch(e => setErr(e.response?.data?.error || e.message)), [cabinet]);
  useEffect(() => { load().then(d => { if (d?.snaps?.length) setSel(s => s || d.snaps[d.snaps.length - 1].id); }); }, [load]);
  // Заказы Ozon по дням и цены на сайте — для оценки результата и сверки.
  useEffect(() => {
    if (!log?.snaps?.length) return;
    const from = dayjs(log.snaps[0].date).subtract(14, 'day').format('YYYY-MM-DD');
    const to = dayjs().format('YYYY-MM-DD');
    getSalesData(cabinet, { dateFrom: dayjs(to).diff(from, 'day') > 400 ? dayjs(to).subtract(400, 'day').format('YYYY-MM-DD') : from, dateTo: to }).then(r => setSales(r.data.data)).catch(() => {});
  }, [cabinet, log?.snaps?.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    getCalcBase(cabinet).then(r => {
      const d = r.data.data, m = new Map();
      for (const x of d.a || []) { const o = d.articles[x[0]]?.o; if (o) m.set(o, { card: x[34] || null, site: x[35] || null, at: x[36] }); }
      setSite(m);
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

  const snaps = log?.snaps || [];
  const idx = snaps.findIndex(s => s.id === sel);
  const cur = idx >= 0 ? snaps[idx] : null, prev = idx > 0 ? snaps[idx - 1] : null;
  const marks = (log?.marks || {})[sel] || {};
  const daysAfter = cur ? Math.min(7, dayjs().startOf('day').diff(dayjs(cur.date), 'day')) : 0;

  // Изменения недели.
  const changes = useMemo(() => {
    if (!cur) return [];
    const out = [];
    const all = new Set([...Object.keys(cur.items), ...Object.keys(prev?.items || {})]);
    for (const o of all) {
      const a = prev?.items[o], b = cur.items[o];
      const g = a && b ? groupOf(a, b) : null;
      const kind = !prev ? 'first' : a && !b ? 'gone' : !a && b ? 'new' : g ? (b > a ? 'up' : 'down') : 'same';
      out.push({ o, a, b, d: a && b ? b - a : null, pct: a && b ? (b / a - 1) * 100 : null, g, kind });
    }
    return out;
  }, [cur, prev]);
  const groups = useMemo(() => {
    const m = new Map();
    for (const x of changes) if (x.g) { const v = m.get(x.g.key) || { ...x.g, n: 0 }; v.n++; m.set(x.g.key, v); }
    return [...m.values()].sort((a, b) => b.n - a.n);
  }, [changes]);
  const cnt = k => changes.filter(x => x.kind === k).length;

  // Таблица.
  const [fKind, setFKind] = useState('changed');
  const [fGroup, setFGroup] = useState('');
  const [fGoal, setFGoal] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(new Set());
  const [hist, setHist] = useState(null); // артикул для истории
  useEffect(() => { setPicked(new Set()); setFGroup(''); }, [sel]);
  const rows = useMemo(() => changes.map(x => {
    const before = cur ? sumOrders(x.o, dayjs(cur.date).subtract(7, 'day'), 7) : 0;
    const after = cur ? sumOrders(x.o, cur.date, Math.max(daysAfter, 0)) : 0;
    const afterN = daysAfter > 0 ? after * 7 / daysAfter : null; // в пересчёте на 7 дней
    const mk = marks[x.o] || {};
    const s = site?.get(x.o);
    const ref = s?.card || null;
    const off = ref && x.b ? (ref / x.b - 1) * 100 : null;
    return { ...x, before, after, afterN, goal: mk.goal || '', note: mk.note || '', cat: ord?.cat.get(x.o) || '', site: s, off,
      v: x.kind === 'up' || x.kind === 'down' ? verdict(x.d, mk.goal, before, afterN ?? 0, daysAfter) : null };
  }), [changes, cur, daysAfter, marks, site, ord]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = rows.filter(r => (fKind === 'all' || (fKind === 'changed' ? (r.kind === 'up' || r.kind === 'down') : r.kind === fKind))
    && (!fGroup || r.g?.key === fGroup) && (!fGoal || (fGoal === '—' ? !r.goal : r.goal === fGoal))
    && (!q || r.o.toLowerCase().includes(q.toLowerCase()) || r.cat.toLowerCase().includes(q.toLowerCase())));
  const ctl = useTableCtl(`pricelog-${cabinet}`, { k: 'pct', dir: 1 });
  const GET = { o: r => r.o, cat: r => r.cat, a: r => r.a, b: r => r.b, d: r => r.d, pct: r => r.pct, before: r => r.before, after: r => r.afterN, goal: r => r.goal, off: r => (r.off === null ? null : Math.abs(r.off)) };
  const shown = ctl.apply(list, (r, k) => (GET[k] ? GET[k](r) : null));
  const [full, setFull] = useState(false);
  const vis = full ? shown : shown.slice(0, 50);

  async function onFile(e) {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    setMsg(null);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await f.arrayBuffer());
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
      const items = parsePrices(aoa);
      const n = Object.keys(items).length;
      if (!n) { setMsg({ bad: true, text: 'Не нашёл в файле колонку «Дефлай» с ценами.' }); return; }
      if (/вб|wb|wildberries/i.test(f.name) && !window.confirm('Похоже, это файл WB, а журнал пока ведём только по Ozon. Всё равно загрузить как Ozon?')) return;
      const exists = snaps.some(s => s.date === upDate);
      if (!window.confirm(`Цены Ozon «Дефлай» на ${dayjs(upDate).format('DD.MM.YYYY')}: ${n} артикулов.${exists ? ' Снимок на эту дату заменится.' : ''} Загрузить?`)) return;
      const r = await uploadPriceLog(cabinet, platform, upDate, items, f.name);
      setLog(l => ({ ...l, snaps: r.data.data.snaps }));
      setSel(upDate);
      setMsg({ text: `Загружено: ${n} цен на ${dayjs(upDate).format('DD.MM.YYYY')}.` });
    } catch (x) { setMsg({ bad: true, text: 'Не удалось прочитать файл: ' + x.message }); }
  }
  const mark = (offers, goal, note) => markPriceLog(cabinet, platform, sel, offers, goal, note).then(r => setLog(l => ({ ...l, marks: r.data.data.marks }))).catch(e => setMsg({ bad: true, text: e.message }));
  const [bulkGoal, setBulkGoal] = useState('');
  const [bulkNote, setBulkNote] = useState('');
  const togglePick = o => setPicked(p => { const n = new Set(p); if (n.has(o)) n.delete(o); else n.add(o); return n; });

  // Итог по целям недели: сколько артикулов и как в среднем изменились заказы.
  const goalSummary = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      if (!(r.kind === 'up' || r.kind === 'down')) continue;
      const g = r.goal || (r.kind === 'down' ? '_down' : '_up');
      const v = m.get(g) || { n: 0, before: 0, after: 0 };
      v.n++; v.before += r.before; v.after += r.afterN || 0;
      m.set(g, v);
    }
    return [...m.entries()];
  }, [rows]);

  if (err && !log) return <div className="mpui"><div className="a-empty" style={{ padding: 40 }}>Не удалось загрузить: {err}</div></div>;
  if (!log) return <div className="mpui"><div className="a-empty" style={{ padding: 40, textAlign: 'center' }}>Загрузка…</div></div>;

  const histRows = hist ? snaps.map((s, i) => {
    const p = s.items[hist], pp = i > 0 ? snaps[i - 1].items[hist] : null;
    return { s, p, pp, ch: p && pp ? (p / pp - 1) * 100 : null, ord: sumOrders(hist, s.date, 7), mk: (log.marks[s.id] || {})[hist] };
  }).filter(x => x.p) : [];

  return (
    <div className="mpui">
      <div className="page-sticky">
        <div className="a-top">
          <h1>Журнал цен</h1>
          <span className="a-seg"><button type="button" className="on">Ozon · Дефлай</button><button type="button" disabled title="Добавим позже">WB — позже</button></span>
          <span className="a-hint" style={{ margin: 0 }}>цены для клиента из репрайсера, раз в неделю</span>
        </div>
      </div>
      {msg && <div className={`c-msg ${msg.bad ? 'bad' : ''}`} style={{ margin: '10px 0' }}>{msg.text}</div>}

      <div className="a-card pr-card">
        <div className="a-bar" style={{ gap: 10, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 14 }}>Недели</b>
          <span className="pl-weeks">
            {snaps.map(s => (
              <button key={s.id} type="button" className={`s-chip ${sel === s.id ? 'on' : ''}`} onClick={() => setSel(s.id)} title={s.file}>
                {dayjs(s.date).format('DD.MM')}<b className="n">{Object.keys(s.items).length}</b>
              </button>
            ))}
            {!snaps.length && <span className="muted">пока нет — загрузите первую таблицу цен</span>}
          </span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <input className="a-input" type="date" value={upDate} onChange={e => setUpDate(e.target.value)} title="Дата, на которую цены выставлены (обычно среда)" />
            <label className="a-btn" style={{ cursor: 'pointer' }}>Загрузить цены<input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={onFile} /></label>
            {cur && <button type="button" className="a-btn ghost" title="Удалить этот снимок" onClick={() => { if (window.confirm(`Удалить снимок цен на ${dayjs(cur.date).format('DD.MM.YYYY')}?`)) deletePriceLog(cabinet, platform, cur.id).then(r => { setLog(l => ({ ...l, snaps: r.data.data.snaps })); setSel(r.data.data.snaps.at(-1)?.id || null); }); }}>×</button>}
          </span>
        </div>
        <div className="a-hint" style={{ marginTop: 6 }}>Файл из репрайсера: артикул в первой колонке, цены — в колонке «Дефлай». Остальные магазины пока не трогаем.</div>
      </div>

      {cur && (
        <div className="a-card pr-card">
          <div className="a-bar" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 10 }}>
            <b style={{ fontSize: 14 }}>{prev ? `Изменения ${dayjs(prev.date).format('DD.MM')} → ${dayjs(cur.date).format('DD.MM.YYYY')}` : `Первый снимок ${dayjs(cur.date).format('DD.MM.YYYY')} — изменения будут видны со следующей загрузки`}</b>
            {prev && <span className="a-hint" style={{ margin: 0 }}>заказы Ozon: 7 дней до {dayjs(cur.date).format('DD.MM')} и {daysAfter > 0 ? `${daysAfter} дн после (в пересчёте на 7)` : 'после — ещё нет данных'}</span>}
          </div>
          {prev && (
            <>
              <div className="pl-sum">
                <button type="button" className={`pl-k up ${fKind === 'up' ? 'on' : ''}`} onClick={() => setFKind(k => (k === 'up' ? 'changed' : 'up'))}><b>{cnt('up')}</b> подняли</button>
                <button type="button" className={`pl-k dn ${fKind === 'down' ? 'on' : ''}`} onClick={() => setFKind(k => (k === 'down' ? 'changed' : 'down'))}><b>{cnt('down')}</b> снизили</button>
                <button type="button" className={`pl-k ${fKind === 'same' ? 'on' : ''}`} onClick={() => setFKind(k => (k === 'same' ? 'changed' : 'same'))}><b>{cnt('same')}</b> без изменений</button>
                {cnt('new') > 0 && <button type="button" className={`pl-k ${fKind === 'new' ? 'on' : ''}`} onClick={() => setFKind(k => (k === 'new' ? 'changed' : 'new'))}><b>{cnt('new')}</b> новые</button>}
                {cnt('gone') > 0 && <button type="button" className={`pl-k ${fKind === 'gone' ? 'on' : ''}`} onClick={() => setFKind(k => (k === 'gone' ? 'changed' : 'gone'))}><b>{cnt('gone')}</b> пропали</button>}
              </div>
              {groups.length > 0 && (
                <div className="pl-groups">
                  <span className="a-hint" style={{ margin: 0 }}>как меняли:</span>
                  {groups.slice(0, 16).map(g => (
                    <button key={g.key} type="button" className={`s-chip ${fGroup === g.key ? 'on' : ''}`} onClick={() => setFGroup(v => (v === g.key ? '' : g.key))}>
                      <span className={g.sort > 0 ? 's-up' : 's-down'}>{g.label}</span> <b className="n">{g.n} арт.</b>
                    </button>
                  ))}
                </div>
              )}
              {goalSummary.length > 0 && (
                <div className="pl-goals">
                  {goalSummary.map(([g, v]) => {
                    const ch = v.before > 0 ? (v.after / v.before - 1) * 100 : null;
                    return (
                      <div key={g} className="pl-goal">
                        <div className="pl-goalt">{g === '_down' ? 'Снизили, цель не указана' : g === '_up' ? 'Подняли, цель не указана' : GOAL[g] || g}</div>
                        <div><b>{v.n}</b> арт. · заказы {fmtInt(v.before)} → {daysAfter > 0 ? fmtInt(v.after) : '…'} шт/нед {daysAfter > 0 && ch !== null ? <b className={ch >= 0 ? 's-up' : 's-down'}>{f1(ch)}</b> : null}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {cur && (
        <div className="a-card pr-card">
          <div className="a-bar" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <b style={{ fontSize: 14 }}>Артикулы</b>
            <span className="a-seg">
              {[['changed', 'Изменённые'], ['all', 'Все']].map(([k, t]) => <button key={k} type="button" className={fKind === k ? 'on' : ''} onClick={() => setFKind(k)}>{t}</button>)}
            </span>
            <select className="a-input" value={fGoal} onChange={e => setFGoal(e.target.value)} style={{ padding: '5px 8px' }}>
              <option value="">Все цели</option><option value="—">Без цели</option>{GOALS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
            </select>
            <input className="a-input" placeholder="Артикул или категория" value={q} onChange={e => setQ(e.target.value)} style={{ minWidth: 200 }} />
            <ResetCtl ctl={ctl} style={{ marginLeft: 'auto' }} />
          </div>
          {picked.size > 0 && (
            <div className="pl-bulk">
              Выбрано {picked.size}:
              <select className="a-input" value={bulkGoal} onChange={e => setBulkGoal(e.target.value)}><option value="">цель…</option>{GOALS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}<option value="-">снять цель</option></select>
              <input className="a-input" placeholder="заметка (почему меняли)" value={bulkNote} onChange={e => setBulkNote(e.target.value)} style={{ minWidth: 260 }} />
              <button type="button" className="a-btn" onClick={() => { mark([...picked], bulkGoal === '-' ? null : bulkGoal || undefined, bulkNote || undefined); setBulkNote(''); setBulkGoal(''); setPicked(new Set()); }}>Сохранить</button>
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
                <ThCtl ctl={ctl} k="after" hint="Заказы Ozon после изменения, в пересчёте на 7 дней">Заказы после</ThCtl>
                <ThCtl ctl={ctl} k="goal" className="" filter={false}>Цель и заметка</ThCtl>
                <th className="" style={{ textAlign: 'left' }}>Итог</th>
                <ThCtl ctl={ctl} k="off" unit="%" hint="Цена для покупателя с Ozon-картой на сайте (по расширению «Соинвест») против загруженной. Расхождение больше 3% — цена не применилась или её перебила акция">На сайте</ThCtl>
              </tr></thead>
              <tbody>
                {!vis.length && <tr><td colSpan={11} className="muted" style={{ padding: 14 }}>{prev ? 'Ничего не подходит под фильтр' : 'Изменения появятся после второй загрузки'}</td></tr>}
                {vis.map(r => (
                  <tr key={r.o} className={picked.has(r.o) ? 'pr-in-order' : ''}>
                    <td><input type="checkbox" checked={picked.has(r.o)} onChange={() => togglePick(r.o)} /></td>
                    <td><div className="a-art" style={{ cursor: 'pointer' }} onClick={() => setHist(r.o)} title="История цены и заказов"><div style={{ minWidth: 0 }}><div className="id">{r.o}</div><div className="model" title={r.cat}>{r.cat.split(SEP).slice(-1)[0] || ''}</div></div></div></td>
                    <td className="n r">{rub(r.a)}</td>
                    <td className="n r"><b>{rub(r.b)}</b></td>
                    <td className="n r"><span className={r.d > 0 ? 's-up' : r.d < 0 ? 's-down' : ''}>{r.d ? drub(r.d) : '—'}</span></td>
                    <td className="n r"><span className={r.pct > 0 ? 's-up' : r.pct < 0 ? 's-down' : ''}>{r.pct ? f1(r.pct) : '—'}</span></td>
                    <td className="n r">{fmtInt(r.before)}</td>
                    <td className="n r">{daysAfter > 0 ? <>{fmtInt(r.afterN)}{r.before > 0 ? <small className={`pr-sub2 ${r.afterN >= r.before ? 's-up' : 's-down'}`}>{f1((r.afterN / r.before - 1) * 100)}</small> : null}</> : '…'}</td>
                    <td className="pr-l" style={{ minWidth: 220 }}>
                      <select className="a-input pr-sel" value={r.goal} onChange={e => mark([r.o], e.target.value || null, undefined)}>
                        <option value="">— цель —</option>{GOALS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                      </select>
                      <input className="a-input pl-note" defaultValue={r.note} key={sel + r.o + r.note} placeholder="заметка" onBlur={e => { if (e.target.value !== r.note) mark([r.o], undefined, e.target.value || null); }} />
                    </td>
                    <td className="pr-l" style={{ whiteSpace: 'normal', minWidth: 220 }}>{r.v ? <span className={`pr-sig ${r.v.cls}`} style={{ whiteSpace: 'normal' }}>{r.v.t}</span> : <span className="muted">—</span>}</td>
                    <td className="n r">{r.site?.card ? <span title={`с Ozon-картой ${rub(r.site.card)}, без карты ${rub(r.site.site)}, проверено ${r.site.at || '—'}`}>{rub(r.site.card)}{r.off !== null && Math.abs(r.off) > 3 ? <small className="pr-sub2 s-down">расходится {f1(r.off)}</small> : null}</span> : '—'}</td>
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
            <div className="a-bar" style={{ marginBottom: 8 }}><b style={{ fontSize: 15 }}>{hist}</b><span className="a-hint" style={{ margin: 0 }}>{ord?.cat.get(hist) || ''}</span>
              <button type="button" className="a-btn ghost" style={{ marginLeft: 'auto' }} onClick={() => setHist(null)}>×</button></div>
            <table className="a-t s-slice">
              <thead><tr><th>Неделя</th><th className="r">Цена</th><th className="r">Изменение</th><th className="r">Заказы за 7 дн после</th><th>Цель / заметка</th></tr></thead>
              <tbody>
                {histRows.slice().reverse().map(x => (
                  <tr key={x.s.id}>
                    <td>{dayjs(x.s.date).format('DD.MM.YYYY')}</td>
                    <td className="n r"><b>{rub(x.p)}</b></td>
                    <td className="n r"><span className={x.ch > 0 ? 's-up' : x.ch < 0 ? 's-down' : ''}>{x.ch ? f1(x.ch) : '—'}</span></td>
                    <td className="n r">{fmtInt(x.ord)}</td>
                    <td>{x.mk?.goal ? GOAL[x.mk.goal] : ''}{x.mk?.note ? <span className="muted"> — {x.mk.note}</span> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
