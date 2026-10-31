import React, { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { getDeflectors2d, getDeflectors2dDemand, getDeflectors2dCatalog, saveDeflectors2d, submitDeflectors2d, getDeflectors2dInventory } from '../api';
import Deflectors2dJournal from './Deflectors2dJournal';
import Deflectors2dAnnual from './Deflectors2dAnnual';
import { calculate2d, PERIODS_2D } from '../lib/deflectors2d.mjs';
import { useTableCtl, ThCtl, ResetCtl } from '../components/TableTools';
import { fmtInt } from './AdsStats2';
import './production.css';

const fmt = v => v == null ? '—' : v.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const COLUMNS = [
  ['offer', 'Артикул'], ['name', 'Наименование'], ['sales', 'Продажи, шт'], ['stock', 'Остаток, шт'], ['transit', 'В пути, шт'],
  ['rate', 'Продажи в день, шт'], ['cover', 'Запас, дней'], ['need', 'Потребность, шт'], ['recommended', 'Рекомендовано, шт'],
  ['quantity', 'Подсорт, шт'], ['after', 'Запас после подсорта, дней'], ['note', 'Комментарий'],
];
const HISTORY_COLS = [...PERIODS_2D.map(d => ['q' + d, `МП ${d === 365 ? 'год' : d + ' дн'}, шт`]), ['trend7', 'Динамика 7 / 7 дней, %'], ['trend14', 'Динамика 14 / 14 дней, %'], ['trend30', 'Динамика 30 / 30 дней, %'], ['lastYear30', 'МП 30 дней год назад, шт'], ['annual1c', '1С за год, шт'], ['annualRate1c', '1С в день, шт']];
COLUMNS.splice(3, 0, ...HISTORY_COLS);
COLUMNS.push(['priority', 'Приоритет']);
COLUMNS.push(['rateWindow', 'Периоды расчёта темпа, дней']);
const BASE_KEYS = ['sales', 'stock', 'transit', 'rate', 'cover', 'need', 'recommended', 'quantity', 'after'];
const DEFAULT_COLS = ['offer', 'name', 'quantity'];
const CACHE = 'mp-deflectors2d-draft';
function ExportDialog({ plan, selected, setSelected, busy, error, date, setDate, expectedDate, setExpectedDate, note, setNote, onClose, download, submit }) {
  const ref = useRef(null);
  useEffect(() => { ref.current.showModal(); }, []);
  return <dialog ref={ref} className="mpui" aria-labelledby="d2-export" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }} style={{ width: 550, maxWidth: '90vw', maxHeight: '85vh', overflow: 'auto', borderRadius: 12, padding: 22, border: '1px solid var(--a-line2)', background: 'var(--a-panel)', color: 'var(--a-ink)' }}>
    <h3 id="d2-export" style={{ marginTop: 0 }}>Подсорт дефлекторов 2D</h3>
    <p>{plan.rows.length} артикулов · {fmtInt(plan.total)} шт · строки с учётом фильтров</p>
    <div className="a-bar"><label>Дата подачи <input className="a-input" type="date" value={date} onChange={e => setDate(e.target.value)} disabled={busy || !!plan.past} /></label><label>Поступление <input className="a-input" type="date" min={date} value={expectedDate} onChange={e => setExpectedDate(e.target.value)} disabled={busy || !!plan.past} /></label></div>
    <label style={{ display: 'block', margin: '12px 0' }}>Комментарий к подсорту <input className="a-input" value={note} onChange={e => setNote(e.target.value)} disabled={busy || !!plan.past} style={{ width: '100%' }} /></label>
    <div className="a-bar"><b>Колонки файла</b><button className="a-btn ghost" disabled={busy} onClick={() => setSelected(COLUMNS.map(c => c[0]))}>Все</button><button className="a-btn ghost" disabled={busy} onClick={() => setSelected(DEFAULT_COLS)}>Артикул, название и количество</button></div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10, margin: '14px 0' }}>{COLUMNS.map(([k, label]) => <label key={k}><input type="checkbox" checked={selected.includes(k)} disabled={busy || k === 'offer'} onChange={() => setSelected(v => v.includes(k) ? v.filter(x => x !== k) : [...v, k])} /> {label}</label>)}</div>
    {error && <p role="alert" style={{ color: 'var(--a-bad)' }}>{error}</p>}
    <div className="a-bar" style={{ justifyContent: 'flex-end' }}>
      <button className="a-btn ghost" disabled={busy} onClick={onClose}>Отмена</button>
      <button className="a-btn ghost" disabled={busy} onClick={download}>Только скачать</button>
      {!plan.past && <button className="a-btn" disabled={busy || !date} onClick={submit}>{busy ? 'Сохранение…' : 'Сохранить в журнал и скачать'}</button>}
    </div>
  </dialog>;
}

export default function Deflectors2d({ nav }) {
  const [demand, setDemand] = useState(null), [demandError, setDemandError] = useState(''), [demandBusy, setDemandBusy] = useState(false);
  const [state, setState] = useState(null), [draft, setDraft] = useState(null), [catalog, setCatalog] = useState([]);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [q, setQ] = useState(''), [only, setOnly] = useState(false), [missing, setMissing] = useState(false);
  const [newOffer, setNewOffer] = useState(''), [newName, setNewName] = useState('');
  const [exportPlan, setExportPlan] = useState(null), [exportError, setExportError] = useState('');
  const [columns, setColumns] = useState(() => { try { const v = JSON.parse(localStorage.getItem('mp-deflectors2d-columns')); return Array.isArray(v) ? [...new Set(['offer', ...v])] : DEFAULT_COLS; } catch { return DEFAULT_COLS; } });
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD')), [note, setNote] = useState('');
  const [section, setSection] = useState('production'), [selected, setSelected] = useState('');
  const [favorites, setFavorites] = useState(false), [priority, setPriority] = useState('');
  const [inventory, setInventory] = useState(null), [inventoryError, setInventoryError] = useState('');
  const [expectedDate, setExpectedDate] = useState(dayjs().add(7, 'day').format('YYYY-MM-DD'));
  const [tableColumns, setTableColumns] = useState(() => { try { return JSON.parse(localStorage.getItem('mp-d2-visible-columns')) || ['cover','transit','priority','recommended','quantity','trend7']; } catch { return ['cover','transit','priority','recommended','quantity','trend7']; } });
  const ctl = useTableCtl('deflectors2d', { k: 'cover', dir: 1 });
  async function load(restore = true) {
    setError(''); setMessage('');
    try {
      const r = await getDeflectors2d(), value = r.data.data;
      setState(value); setInventory(value.inventory); setInventoryError('');
      let cached;
      if (restore) try { cached = JSON.parse(localStorage.getItem(CACHE)); } catch { /* ignore */ }
      const next = cached?.draft || value.draft;
      setDraft({ ...next, settings: { ...next.settings, source: next.settings.source || 'ozon', stockSource: next.settings.stockSource || 'manual', transitSource: next.settings.transitSource || (next.settings.stockSource ? 'live' : 'manual') } });
      if (cached?.draft && cached.revision !== value.revision) { setState(s => ({ ...s, revision: cached.revision })); setMessage('Есть локальные правки к старой версии. Скачайте их перед обновлением: запись на сервер будет защищена от перезаписи чужих изменений.'); }
    } catch (e) { setError(e.response?.data?.error || e.message); }
  }
  async function loadDemand(refresh = false) {
    setDemandBusy(true); setDemandError('');
    try { const r = await getDeflectors2dDemand(refresh); setDemand(r.data.data); }
    catch (e) { setDemandError(e.response?.data?.error || e.message); }
    finally { setDemandBusy(false); }
  }
  useEffect(() => { load(); loadDemand(); getDeflectors2dCatalog().then(r => setCatalog(r.data.data)).catch(() => setMessage('Не удалось получить список из каталога. Артикулы можно добавить вручную.')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (draft && catalog.length) add(catalog); }, [catalog, !!draft]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { localStorage.setItem('mp-d2-visible-columns', JSON.stringify(tableColumns)); }, [tableColumns]);
  const receivingCabinet = draft?.settings?.receivingCabinet || 'defly';
  const inventoryRequest = useRef(0);
  async function refreshInventory() {
    const request = ++inventoryRequest.current;
    try { const r = await getDeflectors2dInventory(receivingCabinet); if (request === inventoryRequest.current) { setInventory(r.data.data); setInventoryError(''); } }
    catch (e) { if (request === inventoryRequest.current) setInventoryError(e.response?.data?.error || e.message); }
  }
  useEffect(() => { if (!draft) return; setInventory(null); refreshInventory(); const timer = setInterval(refreshInventory, 60000); window.addEventListener('focus', refreshInventory); return () => { inventoryRequest.current++; clearInterval(timer); window.removeEventListener('focus', refreshInventory); }; }, [receivingCabinet, !!draft]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!state && !!draft && JSON.stringify(draft) !== JSON.stringify(state.draft);
  useEffect(() => {
    if (!draft || !state) return;
    try { if (dirty) localStorage.setItem(CACHE, JSON.stringify({ revision: state.revision, draft })); else localStorage.removeItem(CACHE); } catch { /* ignore */ }
  }, [draft, state, dirty]);
  useEffect(() => { try { localStorage.setItem('mp-deflectors2d-columns', JSON.stringify(columns)); } catch { /* ignore */ } }, [columns]);
  const preview = useMemo(() => { if (!draft) return null; try { return calculate2d(draft, demand, inventory); } catch (e) { return { rows: draft.rows.map(r => ({ ...r, quantity: r.manual || 0 })), total: 0, left: 0, over: 0, issues: [e.message], invalid: true }; } }, [draft, demand, inventory]);
  const shown = useMemo(() => !preview ? [] : ctl.apply(preview.rows.filter(r => (!q || `${r.offer} ${r.name}`.toLowerCase().includes(q.toLowerCase())) && (!only || r.quantity > 0) && (!favorites || r.favorite) && (!priority || r.priority === priority) && (!missing || r.rate == null || r.stock == null || r.transit == null)), (r, k) => r[k]), [preview, q, only, favorites, priority, missing, ctl.apply]);
  const patch = (offer, changes) => setDraft(v => ({ ...v, rows: v.rows.map(r => r.offer === offer ? { ...r, ...changes } : r) }));
  const setting = (key, value) => setDraft(v => ({ ...v, settings: { ...v.settings, [key]: value } }));
  function add(items) {
    setDraft(v => {
      const known = new Set(v.rows.map(r => r.offer.toLowerCase()));
      const rows = [...v.rows];
      for (const item of items) if (item.offer.trim() && !known.has(item.offer.trim().toLowerCase())) { known.add(item.offer.trim().toLowerCase()); rows.push({ offer: item.offer.trim(), name: item.name || '', sales: null, stock: null, transit: 0, manual: null, enabled: true, note: '' }); }
      return { ...v, rows };
    });
  }
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try { const r = await saveDeflectors2d({ revision: state.revision, draft }); setState(r.data.data); setDraft(r.data.data.draft); setInventory(r.data.data.inventory); setMessage('Таблица и настройки сохранены на сервере.'); }
    catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setBusy(false); }
  }
  function openExport(rows, past = null) {
    const selected = rows.filter(r => r.quantity > 0);
    if (!selected.length) return;
    setExpectedDate(past?.expectedDate || dayjs().add(draft.settings.leadDays ?? 7, 'day').format('YYYY-MM-DD'));
    setExportError(''); setNote(past?.note || ''); setDate(past?.date || dayjs().format('YYYY-MM-DD'));
    setExportPlan({ rows: selected, total: selected.reduce((s, r) => s + r.quantity, 0), settings: past?.settings || draft.settings, draft: structuredClone(draft), revision: state.revision, requestId: crypto.randomUUID(), inventoryVersion: inventory?.version, demandVersion: demand?.version, demand: past ? past.demand : demand, annual: past ? past.annual : draft.annual, past });
    if (past?.columns?.length) setColumns([...new Set(['offer', ...past.columns])]);
  }
  async function writeFile(plan, savedDate = date) {
    const XLSX = await import('xlsx'), cols = COLUMNS.filter(([k]) => columns.includes(k));
    const ws = XLSX.utils.aoa_to_sheet([cols.map(c => c[1]), ...plan.rows.map(r => cols.map(([k]) => r[k] ?? null))]);
    ws['!cols'] = cols.map(([k]) => ({ wch: k === 'name' ? 60 : k === 'note' ? 40 : 22 }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Подсорт 2D');
    const s = plan.settings;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Дата подачи', savedDate], ['Ожидаемое поступление', plan.past?.expectedDate || expectedDate], ['Кабинет поступления', s.receivingCabinet || 'defly'], ['Срок поступления, дней', s.leadDays ?? 7], ['Кратность, шт', s.multiple], ['Период между подачами, дней', s.periodDays], ['Источник темпа', s.source === 'ozon' ? 'Заказы маркетплейсов по указанным кабинетам; самовыкупы Ozon исключены' : 'Ручные продажи'], ['Маркетплейсы по дату', plan.demand?.to || ''], ['Кабинеты', plan.demand?.shops?.map(c => c.label).join(', ') || ''], ['Полные периоды маркетплейсов, дней', PERIODS_2D.filter(d => plan.demand?.ranges?.['d' + d]?.complete).join(', ')], ['Вес темпа 7 / 14 / 30 дней', s.source === 'ozon' ? '50% / 30% / 20%; только полные периоды' : ''], ['Период введённых продаж, дней', s.salesDays], ['1С с', plan.annual?.from || ''], ['1С по', plan.annual?.to || ''], ['Файл 1С', plan.annual?.file || ''], ['Общий лимит, шт', s.total], ['В файле, шт', plan.total], ['Комментарий', note]]), 'Параметры');
    XLSX.writeFile(wb, `Подсорт дефлекторов 2D ${savedDate}.xlsx`);
  }
  async function exportFile(toJournal) {
    setBusy(true); setExportError('');
    try {
      if (toJournal && !exportPlan.past) {
        const r = await submitDeflectors2d({ draft: exportPlan.draft, revision: exportPlan.revision, offers: exportPlan.rows.map(r => r.offer), requestId: exportPlan.requestId, columns, date, expectedDate, note, inventoryVersion: exportPlan.inventoryVersion, demandVersion: exportPlan.demandVersion });
        setState(r.data.data); setDraft(r.data.data.draft); setInventory(r.data.data.inventory);
        window.dispatchEvent(new Event('mp-production-updated'));
        setMessage('Подсорт сохранён в журнале. Поданные строки обнулены. Для повторного скачивания используйте журнал.');
        const saved = r.data.data.journal.find(x => x.id === exportPlan.requestId);
        const plan = { ...exportPlan, past: saved };
        setExportPlan(plan);
        await writeFile(plan);
      } else await writeFile(exportPlan);
      setExportPlan(null);
    } catch (e) { setExportError(e.response?.data?.error || e.message); }
    finally { setBusy(false); }
  }
  if (!draft) return <div className="mpui d2-page"><div className="a-top"><h1>Производство</h1>{nav}</div><div className="a-card pr-card">{error || 'Загрузка…'}{error && <button className="a-btn" onClick={() => load()}>Повторить</button>}</div></div>;
  const s = draft.settings, invReady = inventory?.cabinet === receivingCabinet && !inventoryError;
  const stockSource = s.stockSource || 'manual';
  const transitSource = s.transitSource || (s.stockSource ? 'live' : 'manual');
  const canExport = !busy && invReady && !(s.source === 'ozon' && (!demand || demandBusy || demandError)) && !preview.issues.length;
  const numeric = (r, key, label, step = 1) => <input className="a-input d2-num" aria-label={`${label}: ${r.offer}`} type="number" min="0" step={step} value={r[key] ?? ''} placeholder={key === 'manual' ? String(r.quantity || 0) : '—'} onChange={e => patch(r.offer, { [key]: e.target.value === '' ? null : Number(e.target.value) })} />;
  const order = ['stock','cover','transit','priority','recommended','quantity','trend7','trend14','trend30',...HISTORY_COLS.map(([k]) => k),'rate','after','sales','name','note','need','rateWindow'];
  const displayedColumns = [...new Set(order)].filter(k => tableColumns.includes(k) && (k !== 'sales' || s.source !== 'ozon'));
  const cell = (r, k) => {
    if (k === 'quantity') return <>{numeric(r, 'manual', 'Подсорт', s.multiple)}{r.manual !== null && <button className="tt-reset" aria-label={`Автоматическое количество: ${r.offer}`} onClick={() => patch(r.offer, { manual: null })}>↺</button>}</>;
    if (k === 'stock' && stockSource === 'manual') return numeric(r, 'stock', 'Остаток');
    if (k === 'transit' && transitSource === 'manual') return <>{numeric({ ...r, transit: r.legacyTransit }, 'transit', 'Прежний ручной ввод в пути')}<small className="pr-sub2">Всего с заявками: {fmt(r.transit)}</small></>;
    if (k === 'stock' && r.staleStock) return <span title={`Последний снимок: ${r.stockDate}`}>—<small className="pr-sub2">от {dayjs(r.stockDate).format('DD.MM')}</small></span>;
    if (k === 'sales') return numeric(r, 'sales', 'Продажи');
    if (k === 'priority') return <span className={`pr-sig ${r.priority === 'Срочно' ? 'warn' : ''}`}>{r.priority}</span>;
    if (k === 'note') return <input className="a-input" value={r.note} aria-label={`Комментарий: ${r.offer}`} onChange={e => patch(r.offer, { note: e.target.value })} />;
    if (typeof r[k] === 'string') return r[k];
    return <span className={k.startsWith('trend') && r[k] != null ? r[k] > 0 ? 's-up' : 's-down' : ''}>{fmt(r[k])}{k.startsWith('trend') && r[k] != null ? '%' : ''}</span>;
  };
  return <div className="mpui d2-page">
    <div className="page-sticky"><div className="a-top"><h1>Производство</h1>{nav}<span className="a-seg"><button className={section === 'production' ? 'on' : ''} onClick={() => setSection('production')}>Производство</button><button className={section === 'journal' ? 'on' : ''} onClick={() => setSection('journal')}>Журнал</button></span></div></div>
    {error && <div className="c-msg bad" role="alert">{error}</div>}{message && <div className="c-msg" role="status">{message}</div>}
    {inventoryError && <div className="c-msg bad">Не удалось обновить остатки: {inventoryError} <button className="a-btn" onClick={refreshInventory}>Повторить</button></div>}
    <fieldset disabled={busy} className="d2-fieldset">
    <div hidden={section !== 'production'}>
    <div className="a-card pr-card">
      <div className="a-bar"><details className="d2-settings"><summary>Подача: {s.periodDays} дн. · Поступление: {s.leadDays ?? 7} дн. · Кратность: {s.multiple} · Лимит: {s.total} шт.</summary>
        <div className="a-bar d2-settings-fields">{[['multiple','Кратность, шт.'],['periodDays','Подача каждые, дней'],['leadDays','До поступления, дней'],['total','Лимит, шт.']].map(([k,label]) => <label key={k}>{label}<input className="a-input d2-num" aria-label={label} type="number" min={['total','leadDays'].includes(k) ? 0 : 1} value={s[k] ?? 7} onChange={e => setting(k, e.target.value === '' ? '' : Number(e.target.value))} /></label>)}
        <label>Поступление в кабинет<select className="a-input" value={receivingCabinet} onChange={e => setting('receivingCabinet', e.target.value)}>{(state.receivingCabinets || [{id:'defly',label:'Defly'}]).map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        <label>Остатки<select className="a-input" value={stockSource} onChange={e => setting('stockSource', e.target.value)}><option value="live">Из выбранного кабинета</option><option value="manual">Ввести остаток компании</option></select></label>
        <label>В пути<select className="a-input" value={transitSource} onChange={e => setting('transitSource', e.target.value)}><option value="live">Из рекламы и заявок</option><option value="manual">Прежний ручной ввод + заявки</option></select></label>
        <label><input type="checkbox" checked={s.source === 'ozon'} onChange={e => setting('source', e.target.checked ? 'ozon' : 'manual')} /> Продажи всех кабинетов</label>
        {s.source !== 'ozon' && <label>Период продаж, дней<input className="a-input d2-num" type="number" value={s.salesDays} onChange={e => setting('salesDays', Number(e.target.value))} /></label>}
        <label><input type="checkbox" checked={s.fill} onChange={e => setting('fill', e.target.checked)} /> Добрать до лимита сверх потребности</label></div>
        <div className="a-hint">Приоритет — по запасу на срок поступления и интервал подачи. Рекомендации — по темпу продаж 7/14/30 дней; прибыль и реклама пока не меняют количество. «В пути» = открытые заявки + выбранный ручной источник; два ручных источника не складываются. Снимки старше вчерашнего дня не используются как текущий остаток. Поступления определяются по событиям роста остатков выбранного кабинета.</div>
      </details><button className="a-btn ghost" disabled={!dirty || preview.invalid} onClick={save}>Сохранить</button><button className="a-btn ghost" onClick={() => { loadDemand(true); refreshInventory(); }}>Обновить данные</button><button className="a-btn ghost" onClick={() => { if (!dirty || window.confirm('Загрузить серверную версию вместо локальных правок?')) load(false); }}>Загрузить с сервера</button></div>
      <details className="d2-sources"><summary>Источники и годовые продажи 1С</summary><Deflectors2dAnnual annual={draft.annual} rows={draft.rows} apply={annual => setDraft(v => ({ ...v, annual }))} />
        {demand && <div className="a-hint">Продажи: {demand.shops.map(c => c.label).join(', ')} · по {dayjs(demand.to).format('DD.MM.YYYY')}. {PERIODS_2D.filter(d => demand.ranges['d'+d]?.complete).join(', ')} дней полной истории.</div>}
        {demandError && <p role="alert">{demandError}</p>}<div className="a-bar"><input className="a-input" placeholder="Новый артикул" value={newOffer} onChange={e => setNewOffer(e.target.value)} /><input className="a-input" placeholder="Наименование" value={newName} onChange={e => setNewName(e.target.value)} /><button className="a-btn ghost" disabled={!newOffer.trim()} onClick={() => { add([{offer:newOffer,name:newName}]); setNewOffer(''); setNewName(''); }}>Добавить</button></div>
      </details>
      <div className="a-bar d2-filters"><input className="a-input" aria-label="Поиск дефлекторов" placeholder="Артикул или название" value={q} onChange={e => setQ(e.target.value)} /><label><input type="checkbox" checked={only} onChange={e => setOnly(e.target.checked)} /> Только в заказе</label><label><input type="checkbox" checked={favorites} onChange={e => setFavorites(e.target.checked)} /> ★ Избранные</label><label><input type="checkbox" checked={missing} onChange={e => setMissing(e.target.checked)} /> Без данных</label><select className="a-input" aria-label="Приоритет" value={priority} onChange={e => setPriority(e.target.value)}><option value="">Все приоритеты</option>{['Срочно','Пополнить','Хватает','Нет данных'].map(p => <option key={p}>{p}</option>)}</select><ResetCtl ctl={ctl} /></div>
      <details className="d2-columns"><summary>Колонки таблицы · {shown.length} из {preview.rows.length} артикулов</summary><div className="d2-column-options">{COLUMNS.filter(([k]) => k !== 'offer').map(([k,label]) => <label key={k}><input type="checkbox" checked={tableColumns.includes(k)} onChange={() => setTableColumns(v => v.includes(k) ? v.filter(x => x !== k) : [...v,k])} /> {label}</label>)}</div></details>
      <div className="a-scroll"><table className="a-t pr-t d2-table"><thead><tr><th>★</th><ThCtl ctl={ctl} k="offer" filter={false}>Артикул</ThCtl>{displayedColumns.map(k => <ThCtl key={k} ctl={ctl} k={k} filter={!['name','priority','note','rateWindow'].includes(k)}>{COLUMNS.find(c => c[0] === k)?.[1]}</ThCtl>)}</tr></thead><tbody>
      {shown.map(r => <tr key={r.offer} className={`${r.quantity > 0 ? 'pr-in-order' : ''} ${selected === r.offer ? 'd2-selected' : ''}`}><td><button className={`pr-star ${r.favorite ? 'on' : ''}`} aria-label={`Избранное: ${r.offer}`} aria-pressed={r.favorite} onClick={() => patch(r.offer, {favorite:!r.favorite})}>★</button></td><td><button className="d2-article" onClick={() => setSelected(v => v === r.offer ? '' : r.offer)} aria-pressed={selected === r.offer}><b>{r.offer}</b><small className="pr-sub2">{r.name}</small></button></td>{displayedColumns.map(k => <td key={k} className="n r">{cell(r,k)}</td>)}</tr>)}
      {!shown.length && <tr><td colSpan={displayedColumns.length+2}>Нет артикулов по выбранным фильтрам.</td></tr>}</tbody></table></div>
      <div className="a-bar d2-footer"><span>К подаче: <b>{fmt(preview.total)} / {fmt(s.total)} шт.</b>{dirty && <small className="pr-sub2">Есть несохранённые правки</small>}</span><button className="a-btn ghost" disabled={!canExport || !preview.total} onClick={() => openExport(preview.rows)}>Весь подсорт</button><button className="a-btn" disabled={!canExport || !shown.some(r => r.quantity > 0)} onClick={() => openExport(shown)}>Подать подсорт / Excel</button></div>
      {preview.issues.map(t => <div key={t} role="alert" className="s-down">{t}</div>)}{preview.over > 0 && <div className="s-down">Лимит превышен на {fmt(preview.over)} шт.</div>}
      {selected && <div className="a-bar d2-footer"><b>{selected}</b><button className="a-btn ghost" onClick={() => setSection('journal')}>Журнал артикула</button><button className="a-btn ghost" onClick={() => setSelected('')}>Снять выбор</button></div>}
    </div></div>
    <div hidden={section !== 'journal'}><Deflectors2dJournal journal={inventory?.journal || state.journal} rows={preview.rows} inventory={inventory} selected={selected} onClear={() => setSelected('')} onExport={openExport} stockSource={stockSource} /></div>
    </fieldset>
    {exportPlan && <ExportDialog plan={exportPlan} selected={columns} setSelected={setColumns} busy={busy} error={exportError} date={date} setDate={setDate} expectedDate={expectedDate} setExpectedDate={setExpectedDate} note={note} setNote={setNote} onClose={() => setExportPlan(null)} download={() => exportFile(false)} submit={() => exportFile(true)} />}
  </div>;
}
