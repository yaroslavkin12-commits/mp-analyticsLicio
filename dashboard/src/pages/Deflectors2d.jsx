import React, { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { getDeflectors2d, getDeflectors2dDemand, getDeflectors2dCatalog, saveDeflectors2d, submitDeflectors2d } from '../api';
import Deflectors2dAnnual from './Deflectors2dAnnual';
import { calculate2d, PERIODS_2D } from '../lib/deflectors2d.mjs';
import { useTableCtl, ThCtl, ResetCtl } from '../components/TableTools';
import { fmtInt } from './AdsStats2';
import './production.css';

const fmt = v => v == null ? '—' : v.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const COLUMNS = [
  ['offer', 'Артикул'], ['name', 'Наименование'], ['sales', 'Продажи, шт'], ['stock', 'Остаток, шт'], ['transit', 'В пути, шт'],
  ['rate', 'Продажи в день, шт'], ['cover', 'Запас до подсорта, дней'], ['need', 'Потребность, шт'], ['recommended', 'Рекомендация, шт'],
  ['quantity', 'Подсорт, шт'], ['after', 'Запас после подсорта, дней'], ['note', 'Комментарий'],
];
const HISTORY_COLS = [...PERIODS_2D.map(d => ['q' + d, `МП ${d === 365 ? 'год' : d + ' дн'}, шт`]), ['trend7', 'Динамика 7 / 7 дней, %'], ['trend30', 'Динамика 30 / 30 дней, %'], ['lastYear30', 'МП 30 дней год назад, шт'], ['annual1c', '1С за год, шт'], ['annualRate1c', '1С в день, шт']];
COLUMNS.splice(3, 0, ...HISTORY_COLS);
COLUMNS.push(['rateWindow', 'Периоды расчёта темпа, дней']);
const BASE_KEYS = ['sales', 'stock', 'transit', 'rate', 'cover', 'need', 'recommended', 'quantity', 'after'];
const DEFAULT_COLS = ['offer', 'name', 'quantity'];
const CACHE = 'mp-deflectors2d-draft';
function ExportDialog({ plan, selected, setSelected, busy, error, date, setDate, note, setNote, onClose, download, submit }) {
  const ref = useRef(null);
  useEffect(() => { ref.current.showModal(); }, []);
  return <dialog ref={ref} className="mpui" aria-labelledby="d2-export" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }} style={{ width: 550, maxWidth: '90vw', maxHeight: '85vh', overflow: 'auto', borderRadius: 12, padding: 22, border: '1px solid var(--a-line2)', background: 'var(--a-panel)', color: 'var(--a-ink)' }}>
    <h3 id="d2-export" style={{ marginTop: 0 }}>Подсорт дефлекторов 2D</h3>
    <p>{plan.rows.length} артикулов · {fmtInt(plan.total)} шт · строки с учётом фильтров</p>
    <div className="a-bar"><label>Дата подачи <input className="a-input" type="date" value={date} onChange={e => setDate(e.target.value)} disabled={busy || !!plan.past} /></label></div>
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
  const [full, setFull] = useState(false);
  const ctl = useTableCtl('deflectors2d', { k: 'cover', dir: 1 });
  async function load(restore = true) {
    setError('');
    try {
      const r = await getDeflectors2d(), value = r.data.data;
      setState(value);
      let cached;
      if (restore) try { cached = JSON.parse(localStorage.getItem(CACHE)); } catch { /* ignore */ }
      const next = cached?.draft || value.draft;
      setDraft(next.settings.source ? next : { ...next, settings: { ...next.settings, source: 'ozon' } });
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
  const dirty = !!state && !!draft && JSON.stringify(draft) !== JSON.stringify(state.draft);
  useEffect(() => {
    if (!draft || !state) return;
    try { if (dirty) localStorage.setItem(CACHE, JSON.stringify({ revision: state.revision, draft })); else localStorage.removeItem(CACHE); } catch { /* ignore */ }
  }, [draft, state, dirty]);
  useEffect(() => { try { localStorage.setItem('mp-deflectors2d-columns', JSON.stringify(columns)); } catch { /* ignore */ } }, [columns]);
  useEffect(() => { const warn = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  const preview = useMemo(() => { if (!draft) return null; try { return calculate2d(draft, demand); } catch (e) { return { rows: draft.rows.map(r => ({ ...r, quantity: r.manual || 0 })), total: 0, left: 0, over: 0, issues: [e.message], invalid: true }; } }, [draft, demand]);
  const shown = useMemo(() => !preview ? [] : ctl.apply(preview.rows.filter(r => (!q || `${r.offer} ${r.name}`.toLowerCase().includes(q.toLowerCase())) && (!only || r.quantity > 0) && (!missing || r.rate == null || r.stock == null || r.transit == null)), (r, k) => r[k]), [preview, q, only, missing, ctl.apply]);
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
    try { const r = await saveDeflectors2d({ revision: state.revision, draft }); setState(r.data.data); setDraft(r.data.data.draft); setMessage('Таблица и настройки сохранены на сервере.'); }
    catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setBusy(false); }
  }
  function openExport(rows, past = null) {
    const selected = rows.filter(r => r.quantity > 0);
    if (!selected.length) return;
    setExportError(''); setNote(past?.note || ''); setDate(past?.date || dayjs().format('YYYY-MM-DD'));
    setExportPlan({ rows: selected, total: selected.reduce((s, r) => s + r.quantity, 0), settings: past?.settings || draft.settings, draft: structuredClone(draft), revision: state.revision, requestId: crypto.randomUUID(), demandVersion: demand?.version, demand: past ? past.demand : demand, annual: past ? past.annual : draft.annual, past });
    if (past?.columns?.length) setColumns([...new Set(['offer', ...past.columns])]);
  }
  async function writeFile(plan, savedDate = date) {
    const XLSX = await import('xlsx'), cols = COLUMNS.filter(([k]) => columns.includes(k));
    const ws = XLSX.utils.aoa_to_sheet([cols.map(c => c[1]), ...plan.rows.map(r => cols.map(([k]) => r[k] ?? null))]);
    ws['!cols'] = cols.map(([k]) => ({ wch: k === 'name' ? 60 : k === 'note' ? 40 : 22 }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Подсорт 2D');
    const s = plan.settings;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Дата подачи', savedDate], ['Кратность, шт', s.multiple], ['Период между подачами, дней', s.periodDays], ['Источник темпа', s.source === 'ozon' ? 'Заказы маркетплейсов по указанным кабинетам; самовыкупы Ozon исключены' : 'Ручные продажи'], ['Маркетплейсы по дату', plan.demand?.to || ''], ['Кабинеты', plan.demand?.shops?.map(c => c.label).join(', ') || ''], ['Полные периоды маркетплейсов, дней', PERIODS_2D.filter(d => plan.demand?.ranges?.['d' + d]?.complete).join(', ')], ['Вес темпа 7 / 14 / 30 дней', s.source === 'ozon' ? '50% / 30% / 20%; только полные периоды' : ''], ['Период введённых продаж, дней', s.salesDays], ['1С с', plan.annual?.from || ''], ['1С по', plan.annual?.to || ''], ['Файл 1С', plan.annual?.file || ''], ['Общий лимит, шт', s.total], ['В файле, шт', plan.total], ['Комментарий', note]]), 'Параметры');
    XLSX.writeFile(wb, `Подсорт дефлекторов 2D ${savedDate}.xlsx`);
  }
  async function exportFile(toJournal) {
    setBusy(true); setExportError('');
    try {
      if (toJournal && !exportPlan.past) {
        const r = await submitDeflectors2d({ draft: exportPlan.draft, revision: exportPlan.revision, offers: exportPlan.rows.map(r => r.offer), requestId: exportPlan.requestId, columns, date, note, demandVersion: exportPlan.demandVersion });
        setState(r.data.data); setDraft(r.data.data.draft);
        setMessage('Подсорт сохранён в журнале. При повторном скачивании используйте запись журнала.');
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
  const s = draft.settings, visible = full ? shown : shown.slice(0, 200);
  const numeric = (r, key, label, step = 1) => <input className="a-input" aria-label={`${label}: ${r.offer}`} type="number" min="0" step={step} value={r[key] ?? ''} placeholder={key === 'manual' ? String(r.quantity || 0) : 'нет данных'} onChange={e => patch(r.offer, { [key]: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 85 }} />;
  return <div className="mpui d2-page">
    <div className="page-sticky"><div className="a-top"><h1>Производство</h1>{nav}</div></div>
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
    {error && <div className="c-msg bad" role="alert">{error}</div>}{message && <div className="c-msg" role="status">{message}</div>}
    <div className="a-card pr-card">
      <h3 style={{ marginTop: 0 }}>Подсорт дефлекторов 2D</h3>
      <div className="a-bar" style={{ gap: 16, flexWrap: 'wrap' }}>
        {[['multiple', 'Кратность, шт'], ['periodDays', 'Период подачи, дней'], ['total', 'Общее количество, шт'], ...(s.source === 'ozon' ? [] : [['salesDays', 'Период ручных продаж, дней']])].map(([k, label]) => <label key={k}>{label} <input className="a-input" aria-label={label} type="number" min={k === 'total' ? 0 : 1} value={s[k]} onChange={e => setting(k, e.target.value === '' ? '' : Number(e.target.value))} style={{ width: 85 }} /></label>)}
        <button className="a-btn" disabled={busy || preview.invalid || !dirty} onClick={save}>Сохранить таблицу</button>
        <button className="a-btn ghost" disabled={busy} onClick={() => { if (!dirty || window.confirm('Загрузить сохранённую таблицу? Несохранённые правки будут заменены.')) { setMessage(''); load(false); } }}>Обновить</button>
      </div>
      <p className="a-hint">Остаток компании и «В пути» вводятся вручную. Период подачи — запас до следующего подсорта, не срок производства. Пустое значение означает отсутствие данных, а не ноль.</p>
      <div className="a-bar" style={{ flexWrap: 'wrap', margin: '12px 0' }}><label><input type="checkbox" checked={s.source === 'ozon'} onChange={e => setting('source', e.target.checked ? 'ozon' : 'manual')} /> Рекомендации по заказам маркетплейсов со всех кабинетов</label><button className="a-btn ghost" disabled={demandBusy} onClick={() => loadDemand(true)}>{demandBusy ? 'Загрузка продаж…' : 'Обновить продажи маркетплейсов'}</button></div>
      {demandError && <p role="alert" style={{ color: 'var(--a-bad)' }}>Не удалось получить продажи маркетплейсов: {demandError}. Нажмите «Обновить продажи маркетплейсов» для повтора.</p>}
      {demand && <><p className="a-hint">Маркетплейсы: {demand.shops.map(c => c.label).join(', ')} · по {dayjs(demand.to).format('DD.MM.YYYY')} включительно, полные дни · загружено {dayjs(demand.loadedAt).format('DD.MM HH:mm')}. {demand.shops.some(c => c.platform === 'wb') ? 'WB включён в расчёт.' : 'WB пока не передал заказы и в расчёт не включён.'}</p>
        <details><summary>Полнота истории по кабинетам</summary><div className="a-scroll"><table className="a-t no-sh"><thead><tr><th>Кабинет</th>{PERIODS_2D.map(d => <th key={d}>{d} дней</th>)}</tr></thead><tbody>{demand.shops.map(c => <tr key={c.id}><td>{c.label}</td>{PERIODS_2D.map(d => { const p = demand.ranges['d' + d].shops.find(x => x.id === c.id); return <td key={d} style={{ color: p?.days === d ? 'var(--a-good)' : 'var(--a-warn)' }}>{p?.days ?? 0} / {d}</td>; })}</tr>)}</tbody></table></div></details>
        {!demand.ranges.d30.complete && <p style={{ color: 'var(--a-warn)' }}>История за 30 дней неполная. Пустые периоды отмечены «—». Для рекомендации используются только полные периоды 7 / 14 / 30 дней по всем кабинетам; если их нет, автоматического количества нет.</p>}
      </>}
      {s.source === 'ozon' && !demand && <p className="a-hint">До получения данных маркетплейсов автоматические рекомендации не рассчитываются.</p>}
      <label><input type="checkbox" checked={s.fill} onChange={e => setting('fill', e.target.checked)} /> Добрать до общего количества, даже если запаса на период уже хватает</label>
      <p>К подсорту: <b>{fmtInt(preview.total)} шт</b> · не распределено: <b>{fmtInt(preview.left)} шт</b>{preview.over > 0 && <span style={{ color: 'var(--a-warn)' }}> · ручной подсорт превышает лимит на {fmtInt(preview.over)} шт</span>}{dirty && <span className="a-hint"> · есть несохранённые правки</span>}</p>
      {preview.issues.map(t => <div key={t} style={{ color: 'var(--a-bad)' }}>{t}</div>)}
      <details><summary>Как распределяется подсорт</summary><p className="a-hint">Темп маркетплейсов = 50% среднего за 7 дней + 30% за 14 + 20% за 30. Если период неполный, его вес распределяется между доступными полными периодами. В ручном режиме: продажи / период. Динамика сравнивает равные непересекающиеся отрезки 7 / 7 и 30 / 30 дней. Год 1С — отдельный ориентир, в спрос маркетплейсов не добавляется. Потребность = продажи в день × период подачи − остаток − «В пути». Партии распределяются сначала артикулам с меньшим запасом в днях. Ручное количество закрепляется, оставшийся лимит распределяется между другими артикулами. Журнал хранит историю и сам остатки не меняет: поданные количества при необходимости укажите в «В пути».</p></details>
    </div>
    <Deflectors2dAnnual annual={draft.annual} rows={draft.rows} apply={annual => setDraft(v => ({ ...v, annual }))} />
    <div className="a-card pr-card">
      <div className="a-bar" style={{ flexWrap: 'wrap' }}>
        <input className="a-input" aria-label="Поиск дефлекторов" placeholder="Артикул или название" value={q} onChange={e => setQ(e.target.value)} />
        <label><input type="checkbox" checked={only} onChange={e => setOnly(e.target.checked)} /> Только к подсорту</label>
        <label><input type="checkbox" checked={missing} onChange={e => setMissing(e.target.checked)} /> Без данных</label>
        <ResetCtl ctl={ctl} />
        <button className="a-btn" disabled={busy || (s.source === 'ozon' && (!demand || demandBusy || !!demandError)) || !!preview.issues.length || !shown.some(r => r.quantity > 0)} onClick={() => openExport(shown)}>Скачать / в журнал ({shown.filter(r => r.quantity > 0).length})</button>
        <button className="a-btn ghost" disabled={busy || (s.source === 'ozon' && (!demand || demandBusy || !!demandError)) || !!preview.issues.length || !preview.total} onClick={() => openExport(preview.rows)}>Весь подсорт</button>
      </div>
      <p className="a-hint">Фильтры меняют список строк и выгрузку. Рекомендации распределяются по всем включённым артикулам.</p>
      <div className="a-scroll"><table className="a-t pr-t d2-table"><thead><tr>
        <th>В расчёт</th><ThCtl ctl={ctl} k="offer" className="" filter={false}>Артикул</ThCtl><th>Наименование</th>
        {[...HISTORY_COLS, ...COLUMNS.filter(([k]) => BASE_KEYS.includes(k) && (k !== 'sales' || s.source !== 'ozon'))].map(([k, label]) => <ThCtl key={k} ctl={ctl} k={k}>{k === 'sales' ? 'Ручные продажи, шт' : label}</ThCtl>)}<th>Комментарий</th><th />
      </tr></thead><tbody>
        {visible.map(r => <tr key={r.offer}>
          <td><input type="checkbox" aria-label={`В расчёт: ${r.offer}`} checked={r.enabled} onChange={e => patch(r.offer, { enabled: e.target.checked })} /></td>
          <td><b>{r.offer}</b></td><td><input className="a-input" aria-label={`Название: ${r.offer}`} value={r.name} onChange={e => patch(r.offer, { name: e.target.value })} style={{ width: 230 }} /></td>
          {HISTORY_COLS.map(([k]) => <td key={k} className="n r" title={k.startsWith('q') && demand ? `${demand.ranges['d' + k.slice(1)].from} — ${demand.to}; только полные данные всех кабинетов` : ''} style={k.startsWith('trend') && r[k] != null ? { color: r[k] > 0 ? 'var(--a-good)' : r[k] < 0 ? 'var(--a-bad)' : undefined } : undefined}>{fmt(r[k])}{k.startsWith('trend') && r[k] != null ? '%' : ''}</td>)}
          {s.source !== 'ozon' && <td>{numeric(r, 'sales', 'Ручные продажи')}</td>}<td>{numeric(r, 'stock', 'Остаток')}</td><td>{numeric(r, 'transit', 'В пути')}</td>
          <td className="n r" title={s.source === 'ozon' ? `Полные периоды: ${r.ratePeriods?.join(', ') || 'нет'} дней` : 'Ручные продажи / период'}>{fmt(r.rate)}</td><td className="n r">{fmt(r.cover)}</td><td className="n r">{fmt(r.need)}</td><td className="n r">{fmtInt(r.recommended)}</td>
          <td>{numeric(r, 'manual', 'Подсорт вручную', s.multiple)}<small className="pr-sub2">итого {fmtInt(r.quantity)} шт{r.manual !== null && <button className="tt-reset" aria-label={`Убрать ручное количество: ${r.offer}`} onClick={() => patch(r.offer, { manual: null })}>↺</button>}</small></td>
          <td className="n r">{fmt(r.after)}</td><td><input className="a-input" aria-label={`Комментарий: ${r.offer}`} value={r.note} onChange={e => patch(r.offer, { note: e.target.value })} /></td>
          <td><button className="tt-reset" aria-label={`Убрать строку: ${r.offer}`} onClick={() => setDraft(v => ({ ...v, rows: v.rows.filter(x => x.offer !== r.offer) }))}>✕</button></td>
        </tr>)}
        {!visible.length && <tr><td colSpan={30}>Нет строк. Добавьте артикулы вручную или из каталога 2D.</td></tr>}
      </tbody></table></div>
      {shown.length > 200 && <button className="a-btn ghost" onClick={() => setFull(v => !v)}>{full ? 'Свернуть' : `Показать все ${shown.length}`}</button>}
      <div className="a-bar" style={{ marginTop: 14, flexWrap: 'wrap' }}>
        <input className="a-input" aria-label="Новый артикул 2D" placeholder="Артикул" value={newOffer} onChange={e => setNewOffer(e.target.value)} />
        <input className="a-input" aria-label="Название нового артикула" placeholder="Название" value={newName} onChange={e => setNewName(e.target.value)} />
        <button className="a-btn ghost" disabled={!newOffer.trim() || draft.rows.some(r => r.offer.toLowerCase() === newOffer.trim().toLowerCase())} onClick={() => { add([{ offer: newOffer, name: newName }]); setNewOffer(''); setNewName(''); }}>Добавить артикул</button>
        <button className="a-btn ghost" disabled={!catalog.length || !catalog.some(a => !draft.rows.some(r => r.offer.toLowerCase() === a.offer.toLowerCase()))} onClick={() => add(catalog)}>Добавить список из каталога 2D ({catalog.length})</button>
      </div>
    </div>
    <div className="a-card pr-card"><h3 style={{ marginTop: 0 }}>Журнал подсорта 2D</h3>
      <p className="a-hint">Каждая запись хранит количества, рекомендации, исходные данные и настройки на момент подачи. Повторное скачивание не создаёт новую запись.</p>
      {!state.journal.length ? <p>Подсортов пока нет.</p> : state.journal.map(j => <details key={j.id} style={{ marginBottom: 12 }}>
        <summary>{dayjs(j.date).format('DD.MM.YYYY')} · {fmtInt(j.total)} шт · {j.items.length} арт. {j.note && `· ${j.note}`}</summary>
        <p className="a-hint">Кратность {j.settings.multiple}, подача каждые {j.settings.periodDays} дней, {j.settings.source === 'ozon' ? `Маркетплейсы по ${j.demand?.to || '—'}` : `ручные продажи за ${j.settings.salesDays} дней`}. Сохранено {dayjs(j.createdAt).format('DD.MM.YYYY HH:mm')}.</p>
        <button className="a-btn ghost" onClick={() => openExport(j.items, j)}>Скачать запись</button>
        <div className="a-scroll"><table className="a-t"><thead><tr><th>Артикул</th><th>Наименование</th><th>Рекомендация</th><th>Подсорт</th></tr></thead><tbody>{j.items.map(r => <tr key={r.offer}><td>{r.offer}</td><td>{r.name}</td><td>{fmtInt(r.recommended)}</td><td>{fmtInt(r.quantity)}</td></tr>)}</tbody></table></div>
      </details>)}
    </div>
    </fieldset>
    {exportPlan && <ExportDialog plan={exportPlan} selected={columns} setSelected={setColumns} busy={busy} error={exportError} date={date} setDate={setDate} note={note} setNote={setNote} onClose={() => setExportPlan(null)} download={() => exportFile(false)} submit={() => exportFile(true)} />}
  </div>;
}
