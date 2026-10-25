import React, { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { getOzonPlan, getOzonPlanBasis, previewOzonPlan, fixOzonPlan, getOzonPlanExecution } from '../api';
import { SHOPS } from '../lib/cabinets';
import { planTotal as total } from '../lib/planEvaluation';
import PlanExecution from './PlanExecution';
import './ads2.css';
import './plan.css';

const SH = SHOPS.filter(s => s.platform === 'ozon');
const SEP = ' / ';
const fmt = (v, digits = 0) => v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('ru-RU', { maximumFractionDigits: digits });
const rub = v => v === null || v === undefined ? '—' : `${fmt(v, 2)} ₽`;
const pct = v => v === null || v === undefined ? '—' : `${fmt(v, 1)}%`;
const errorText = e => e.response?.data?.error || e.message;
const stamp = v => v ? new Date(v).toLocaleString('ru-RU') : '—';
const readDraft = month => { try { return JSON.parse(localStorage.getItem(`mp-ozon-plan-draft:${month}`)); } catch { return null; } };
const number = v => typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : Number(v);
const inPath = (p, parent) => !parent || p === parent || p.startsWith(parent + SEP);
function draftRows(targets) {
  return Object.entries(targets).filter(([, t]) => t.qty !== '' && t.mean !== '' && t.qty !== undefined && t.mean !== undefined && Number.isFinite(number(t.qty)) && Number.isFinite(number(t.mean))).map(([path, t]) => ({ path, qty: number(t.qty), mean: number(t.mean), amount: number(t.qty) * number(t.mean) }));
}
function Input({ value, onChange, label, ...rest }) {
  return <input className="op-input n" aria-label={label} inputMode="decimal" value={value ?? ''} onChange={e => onChange(e.target.value)} {...rest} />;
}
export default function PlanFact({ active = true }) {
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'));
  const [mode, setMode] = useState('plan');
  const [state, setState] = useState(null), [loadError, setLoadError] = useState('');
  const [targets, setTargets] = useState({});
  const [period, setPeriod] = useState({ from: '', to: '' });
  const [source, setSource] = useState('fact');
  const [basis, setBasis] = useState(null), [basisError, setBasisError] = useState(''), [basisBusy, setBasisBusy] = useState(false);
  const [preview, setPreview] = useState(null), [previewBusy, setPreviewBusy] = useState(false);
  const [actionError, setActionError] = useState(''), [notice, setNotice] = useState('');
  const [ack, setAck] = useState(false), [note, setNote] = useState(''), [saving, setSaving] = useState(false);
  const [manual, setManual] = useState('');
  const [version, setVersion] = useState('');
  const [fact, setFact] = useState(null), [factBusy, setFactBusy] = useState(false), [factError, setFactError] = useState('');
  const [shop, setShop] = useState(''), [path, setPath] = useState('');
  const [refresh, setRefresh] = useState(0), [basisRefresh, setBasisRefresh] = useState(0);
  const [showArchive, setShowArchive] = useState(false);
  const fingerprint = JSON.stringify({ month, targets, period, source, revision: state?.revision });
  const currentInput = useRef(fingerprint); currentInput.current = fingerprint;
  const fixed = state?.versions.find(v => v.id === state.activeId);
  const viewed = state?.versions.find(v => v.id === (version || state.activeId));

  useEffect(() => {
    if (!active) return;
    let off = false;
    setState(null); setLoadError(''); setPreview(null); setActionError(''); setNotice(''); setFact(null); setVersion(''); setPath('');
    getOzonPlan(month).then(r => {
      if (off) return;
      const s = r.data.data, v = s.versions.find(x => x.id === s.activeId), draft = readDraft(month);
      setTargets(draft?.targets || Object.fromEntries((v?.targets || []).map(t => [t.path, { ...t }])));
      setPeriod(draft?.period || (v ? { from: v.basis.from, to: v.basis.to } : s.defaultPeriod));
      setSource(draft?.source || v?.basis.source || 'fact');
      if (draft && draft.revision !== s.revision) setNotice('На сервере есть новая версия. Локальный черновик сохранён; перед фиксацией сравните его с действующим планом.');
      setState(s);
    }).catch(e => { if (!off) setLoadError(errorText(e)); });
    return () => { off = true; };
  }, [month, active]);
  useEffect(() => {
    if (!active || !state || state.month !== month) return;
    try { localStorage.setItem(`mp-ozon-plan-draft:${month}`, JSON.stringify({ revision: state.revision, targets, period, source })); } catch { /* Черновик остаётся в памяти. */ }
  }, [targets, period, source, state, month, active]);
  useEffect(() => {
    if (!active || !state || state.month !== month || !period.from || !period.to) return;
    let off = false;
    setBasis(null); setBasisError(''); setBasisBusy(true); setPreview(null);
    getOzonPlanBasis({ month, ...period, source, refresh: basisRefresh }).then(r => { if (!off) setBasis(r.data.data); })
      .catch(e => { if (!off) setBasisError(errorText(e)); }).finally(() => { if (!off) setBasisBusy(false); });
    return () => { off = true; };
  }, [active, state?.month, month, period.from, period.to, source, basisRefresh]);
  useEffect(() => {
    if (!active || !state || state.month !== month || mode !== 'actual') return;
    let off = false;
    setFact(null); setFactError(''); setFactBusy(true);
    getOzonPlanExecution({ month, version: version || undefined, refresh }).then(r => { if (!off) setFact(r.data.data); })
      .catch(e => { if (!off) setFactError(errorText(e)); }).finally(() => { if (!off) setFactBusy(false); });
    return () => { off = true; };
  }, [active, state?.revision, mode, month, version, refresh]);

  const paths = useMemo(() => [...new Set([...(basis?.paths || []), ...Object.keys(targets), ...(fixed?.targets.map(t => t.path) || [])])].sort((a, b) => (b.startsWith('Чехлы') - a.startsWith('Чехлы')) || a.localeCompare(b, 'ru')), [basis, targets, fixed]);
  const tops = [...new Set(paths.map(p => p.split(SEP)[0]))];
  const filled = draftRows(targets), draftTotal = total(filled);
  const update = (p, field, value) => { setTargets(t => ({ ...t, [p]: { ...(t[p] || {}), [field]: value } })); setPreview(null); setActionError(''); };
  const override = (p, field, id, value) => { setTargets(t => ({ ...t, [p]: { ...(t[p] || {}), [field]: { ...(t[p]?.[field] || {}), [id]: value } } })); setPreview(null); };
  const copy = async () => {
    try {
      const s = (await getOzonPlan(dayjs(month + '-01').subtract(1, 'month').format('YYYY-MM'))).data.data;
      const v = s.versions.find(x => x.id === s.activeId);
      if (!v) { setNotice('В прошлом месяце нет общего плана. Старые планы кабинетов доступны в архиве.'); return; }
      setTargets(Object.fromEntries(v.targets.map(t => [t.path, { ...t, weights: {}, means: {} }]))); setPreview(null);
      setNotice('Цели прошлого месяца скопированы в черновик. Распределение нужно проверить и зафиксировать заново.');
    } catch (e) { setActionError(errorText(e)); }
  };
  const buildPreview = async () => {
    const inputAtStart = currentInput.current;
    setPreviewBusy(true); setActionError(''); setAck(false);
    try {
      const entered = Object.entries(targets).filter(([, t]) => (t.qty !== '' && t.qty !== undefined) || (t.mean !== '' && t.mean !== undefined)).map(([p, t]) => ({ ...t, path: p, qty: t.qty === '' || t.qty === undefined ? '' : number(t.qty), mean: t.mean === '' || t.mean === undefined ? '' : number(t.mean), weights: Object.fromEntries(Object.entries(t.weights || {}).map(([k, v]) => [k, v === '' ? '' : number(v)])), means: Object.fromEntries(Object.entries(t.means || {}).map(([k, v]) => [k, v === '' ? '' : number(v)])) }));
      const result = (await previewOzonPlan({ month, ...period, source, targets: entered, expectedRevision: state.revision })).data.data;
      if (currentInput.current === inputAtStart) setPreview(result);
      else setNotice('Черновик изменился во время расчёта. Постройте предпросмотр ещё раз.');
    } catch (e) { setActionError(errorText(e)); }
    finally { setPreviewBusy(false); }
  };
  const fix = async () => {
    setSaving(true); setActionError('');
    try {
      const s = (await fixOzonPlan({ month, previewId: preview.id, acknowledgeWarnings: ack, note })).data.data;
      setState(prev => ({ ...prev, ...s })); setPreview(null); setNote(''); setNotice('Распределение зафиксировано на месяц. Обновления факта его не изменят.'); setMode('actual'); setVersion(''); setRefresh(x => x + 1);
    } catch (e) { setActionError(errorText(e)); }
    finally { setSaving(false); }
  };
  const preset = kind => {
    const to = state.cutoff;
    if (kind === '30') setPeriod({ from: dayjs(to).subtract(29, 'day').format('YYYY-MM-DD'), to });
    else if (kind === 'previous') { const p = dayjs(month + '-01').subtract(1, 'month'); setPeriod({ from: p.startOf('month').format('YYYY-MM-DD'), to: p.endOf('month').format('YYYY-MM-DD') }); }
    else setPeriod(state.defaultPeriod);
    setPreview(null);
  };
  if (!state || state.month !== month) return <div className="mpui op-page"><h1>План / факт · Ozon</h1><div className={loadError ? 'op-alert bad' : 'a-empty'}>{loadError || 'Загружаем общий план…'}</div>{loadError && <button className="a-btn" onClick={() => window.location.reload()}>Обновить страницу</button>}</div>;
  const rows = viewed?.rows || [];
  const displayRows = [];
  for (const top of tops) {
    const children = paths.filter(p => p.startsWith(top + SEP));
    if (children.length) displayRows.push({ path: top, parent: true, children });
    for (const p of paths.filter(p => p === top || p.startsWith(top + SEP))) displayRows.push({ path: p, parent: false });
  }
  return <div className="mpui op-page">
    <div className="op-heading"><div><h1>План / факт <span>Ozon</span></h1><p>Один план на Defly, NABauto, Alex, Fullgas и Accent Line</p></div><label className="op-month">Месяц<input type="month" value={month} onChange={e => { if (e.target.value) setMonth(e.target.value); }} /></label></div>
    <div className="op-toolbar"><div className="a-seg"><button className={mode === 'plan' ? 'on' : ''} onClick={() => setMode('plan')}>Планирование</button><button className={mode === 'actual' ? 'on' : ''} onClick={() => setMode('actual')}>Выполнение</button></div><span className="op-state">{fixed ? `Зафиксирован · версия ${state.versions.length} · ${stamp(fixed.createdAt)}` : 'План ещё не зафиксирован'}</span></div>
    {notice && <div className="op-alert" role="status">{notice}<button className="op-close" aria-label="Скрыть сообщение" onClick={() => setNotice('')}>×</button></div>}
    {actionError && <div className="op-alert bad" role="alert">{actionError}</div>}
    {mode === 'plan' ? <>
      <section className="a-card op-section"><div className="op-section-head"><div><h2>1. Общие цели на месяц</h2><p>Заполняйте подкатегории. Родительские итоги появятся сразу, даже если остальные строки пусты.</p></div><button className="a-btn" onClick={copy}>Взять цели прошлого месяца</button></div>
        <div className="op-summary"><span><b>{fmt(draftTotal.qty)}</b> выкупов</span><span><b>{rub(draftTotal.mean)}</b> за выкуп</span><small>План задан: {filled.length} из {paths.length} категорий · черновик сохраняется в этом браузере</small></div>
        {!paths.length && <p className="op-muted">{basisBusy ? 'Загружаем категории пяти магазинов…' : 'Категории появятся после загрузки базы распределения.'}</p>}
        {!!paths.length && <div className="op-scroll"><table className="op-table op-targets"><thead><tr><th>Категория / подкатегория</th><th>Выкупы за месяц, шт.</th><th>Поступление за выкуп, ₽</th><th>Распределение</th></tr></thead><tbody>{displayRows.map((r, idx) => {
          const t = targets[r.path] || {}, children = filled.filter(x => inPath(x.path, r.path)), sum = total(children);
          return <React.Fragment key={r.path + idx}><tr className={r.parent ? 'op-parent' : ''}><td className="op-name" style={{ paddingLeft: r.path.includes(SEP) ? 28 : 14 }}>{r.path.split(SEP).at(-1)}{r.parent && <small>План задан: {r.children.filter(p => filled.some(x => x.path === p)).length} из {r.children.length}</small>}</td>
            <td>{r.parent ? <b className="n">{children.length ? fmt(sum.qty) : '—'}</b> : <Input label={`Выкупы: ${r.path}`} value={t.qty} onChange={v => update(r.path, 'qty', v)} placeholder="Не задан" />}</td>
            <td>{r.parent ? <b className="n">{rub(sum.mean)}</b> : <Input label={`Поступление: ${r.path}`} value={t.mean} onChange={v => update(r.path, 'mean', v)} placeholder="Не задано" />}</td>
            <td>{!r.parent && <button className="op-link" onClick={() => setManual(manual === r.path ? '' : r.path)}>{manual === r.path ? 'Скрыть настройки' : 'Доли и база'}</button>}</td></tr>
            {!r.parent && manual === r.path && <tr><td colSpan={4}><div className="op-manual"><b>{r.path} · исходные значения и ручные поправки</b><p>Пустые поля используют историю. Ручные доли — относительные веса: сервис нормирует их до 100%. При отсутствии данных укажите долю явно, включая 0 для исключения магазина.</p><table className="op-table"><thead><tr><th>Магазин</th><th>Выкупы базы</th><th>Факт за выкуп</th><th>Прогноз за выкуп</th><th>Доля вручную</th><th>База поступления вручную, ₽</th></tr></thead><tbody>{SH.map(s => {
              const b = basis?.shops[s.id], v = b?.byPath[r.path], all = SH.reduce((n, x) => n + Math.max(0, basis?.shops[x.id]?.byPath[r.path]?.qty || 0), 0);
              return <tr key={s.id}><td>{s.label}{(b?.error || b?.partial) && <small className="op-bad">{b.error || 'Неполный период'}</small>}</td><td className="n">{b?.error ? '—' : fmt(v?.qty ?? 0)}</td><td>{rub(v?.qty > 0 ? v.payout / v.qty : null)}</td><td>{source === 'forecast' ? rub(v?.forecast?.qty > 0 ? v.forecast.payout / v.forecast.qty : null) : 'Выберите источник «Прогноз»'}</td><td><Input label={`Доля ${s.label}: ${r.path}`} value={t.weights?.[s.id]} placeholder={all > 0 ? fmt(Math.max(0, v?.qty || 0) / all * 100, 2) : 'нет базы'} onChange={v => override(r.path, 'weights', s.id, v)} /></td><td><Input label={`База ${s.label}: ${r.path}`} value={t.means?.[s.id]} placeholder="Из источника" onChange={v => override(r.path, 'means', s.id, v)} /></td></tr>;
            })}</tbody></table></div></td></tr>}
          </React.Fragment>;
        })}</tbody></table></div>}
      </section>
      <section className="a-card op-section"><div className="op-section-head"><div><h2>2. База распределения</h2><p>Доли штук — по выкупам этой категории за вычетом возвратов. Цели поступления сохраняют соотношение средних магазинов.</p></div></div>
        <div className="op-controls"><label>С<input type="date" value={period.from} onChange={e => setPeriod(p => ({ ...p, from: e.target.value }))} /></label><label>По<input type="date" max={state.cutoff} value={period.to} onChange={e => setPeriod(p => ({ ...p, to: e.target.value }))} /></label><button className="a-btn" onClick={() => preset('30')}>Последние 30 полных дней</button><button className="a-btn" onClick={() => preset('previous')}>Прошлый месяц</button><label>База поступления<select value={source} onChange={e => setSource(e.target.value)}><option value="fact">Фактическое поступление</option><option value="forecast">Прогноз из аналитики продаж</option></select></label><button className="a-btn" onClick={() => { setBasisRefresh(x => x + 1); setPreview(null); }}>Обновить базу</button></div>
        <p className="op-muted">Даты Ozon — по Москве. Последние три дня исключены из базы и оценки выполнения из-за задержек начислений. Прогноз использует модель и текущие коэффициенты «Аналитики продаж»; это ориентир, а не гарантия дохода.</p>
        {basisBusy && <div className="op-alert" role="status">Собираем базу пяти магазинов… Это может занять до трёх минут.</div>}
        {basisError && <div className="op-alert bad" role="alert">{basisError}</div>}
        {basis && <div className="op-sources">{SH.map(s => { const b = basis.shops[s.id]; return <div key={s.id}><i style={{ background: s.color }} /><b>{s.label}</b><span className={b.error || b.partial ? 'op-bad' : 'op-muted'}>{b.error || (b.partial ? 'Неполный диапазон финансов' : 'Диапазон финансов покрывает период')}</span><small>Сбор: {stamp(b.updatedAt)}{b.forecastError ? ` · Прогноз недоступен: ${b.forecastError}` : ''}</small></div>; })}</div>}
        <div className="op-actions"><button className="a-btn primary" disabled={!basis || basisBusy || previewBusy || saving} onClick={buildPreview}>{previewBusy ? 'Рассчитываем…' : fixed ? 'Предпросмотр нового распределения' : 'Предпросмотр распределения'}</button><span className="op-muted">Фиксация — отдельным действием после проверки.</span></div>
      </section>
      {preview && <section className="a-card op-section" aria-label="Предпросмотр распределения"><h2>3. Предпросмотр распределения</h2><p className="op-muted">{period.from} — {period.to} · {source === 'fact' ? 'по факту' : 'по прогнозу'} · исходные данные на {stamp(preview.basis.asOf)}</p>
        {!!preview.errors.length && <div className="op-alert bad" role="alert"><b>Распределение пока нельзя зафиксировать</b><ul>{preview.errors.map(x => <li key={x}>{x}</li>)}</ul><p>Откройте «Доли и база» у соответствующей категории и уточните исходные значения.</p></div>}
        {preview.rows.map(r => <div className="op-preview-row" key={r.path}><h3>{r.path} <small>{fmt(r.qty)} шт. · {rub(r.mean)} за выкуп · коэффициент {fmt(r.factor, 4)}</small></h3><div className="op-scroll"><table className="op-table"><thead><tr><th>Магазин</th><th>Доля</th><th>План, шт.</th><th>База, ₽/выкуп</th><th>Цель, ₽/выкуп</th><th>Всего к поступлению</th></tr></thead><tbody>{r.shops.map(s => <tr key={s.id}><td>{s.label}{(s.manualWeight || s.manualMean) && <small>Ручная настройка</small>}</td><td>{pct(s.share * 100)}</td><td className="n">{fmt(s.qty)}</td><td>{rub(s.baseMean)}</td><td>{rub(s.mean)}</td><td>{rub(s.amount)}</td></tr>)}<tr className="op-parent"><td>Итого Ozon</td><td>{r.qty ? '100%' : '—'}</td><td>{fmt(r.qty)}</td><td /><td>{rub(r.qty ? r.shops.reduce((s, x) => s + x.amount, 0) / r.qty : null)}</td><td>{rub(r.amount)}</td></tr></tbody></table></div></div>)}
        {!!preview.warnings.length && <div className="op-alert warn"><ul>{preview.warnings.map(x => <li key={x}>{x}</li>)}</ul><label className="op-check"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />Учёл предупреждения, распределение подходит</label></div>}
        <p className="op-muted">Штуки округлены с сохранением общего плана. Средние хранятся с полной точностью; округление до копеек используется только на экране.</p>
        <div className="op-controls"><label className="op-note">Комментарий к версии<input value={note} maxLength={300} onChange={e => setNote(e.target.value)} placeholder="Например: план после изменения цен" /></label><button className="a-btn primary" disabled={!!preview.errors.length || saving || (preview.warnings.length > 0 && !ack)} onClick={fix}>{saving ? 'Сохраняем…' : 'Зафиксировать на месяц'}</button></div>
        {fixed && <p className="op-muted">Появится новая версия. Предыдущее распределение останется в истории.</p>}
      </section>}
    </> : <>
      <section className="a-card op-section"><div className="op-controls"><label>Магазины<select value={shop} onChange={e => setShop(e.target.value)}><option value="">Весь Ozon</option>{SH.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label><label>Категория<select value={path} onChange={e => setPath(e.target.value)}><option value="">Все запланированные</option>{[...new Set(rows.flatMap(r => [r.path.split(SEP)[0], r.path]))].map(p => <option key={p} value={p}>{p}</option>)}</select></label><label>Версия<select value={version || state.activeId || ''} onChange={e => setVersion(e.target.value)}>{!state.versions.length && <option value="">План не задан</option>}{state.versions.map((v, i) => <option key={v.id} value={v.id}>{i + 1} · {stamp(v.createdAt)}{v.id === state.activeId ? ' · действующая' : ''}</option>)}</select></label><button className="a-btn" disabled={factBusy} onClick={() => setRefresh(x => x + 1)}>Обновить факт</button></div></section>
      {!viewed && <div className="op-alert">Общий план ещё не зафиксирован. Заполните цели в «Планировании» и проверьте распределение.</div>}
      {factBusy && <div className="op-alert" role="status">Загружаем фактические результаты пяти магазинов…</div>}
      {factError && <div className="op-alert bad" role="alert">Не удалось загрузить факт: {factError}. Нулевые результаты не подставлены.</div>}
      {fact && viewed && <PlanExecution month={month} viewed={viewed} paths={paths} fact={fact} shop={shop} path={path} setPath={setPath} />}
    </>}
    <details className="a-card op-section"><summary>История общего плана · {state.versions.length} версий</summary>{!state.versions.length && <p className="op-muted">Версии появятся после первой фиксации.</p>}{state.versions.slice().reverse().map(v => <div className="op-history" key={v.id}><div><b>{stamp(v.createdAt)}{v.id === state.activeId ? ' · действующая' : ''}</b><small>{v.basis.from} — {v.basis.to} · {v.basis.source === 'fact' ? 'факт' : 'прогноз'} · {v.targets.length} категорий{v.note ? ` · ${v.note}` : ''}</small></div><button className="a-btn" onClick={() => { setVersion(v.id); setMode('actual'); }}>Посмотреть выполнение</button><button className="a-btn" onClick={() => { setTargets(Object.fromEntries(v.targets.map(t => [t.path, { ...t }]))); setPeriod({ from: v.basis.from, to: v.basis.to }); setSource(v.basis.source); setPreview(null); setMode('plan'); setNotice('Цели выбранной версии открыты как черновик. Действующая версия не изменена.'); }}>Взять в черновик</button></div>)}</details>
    <details className="a-card op-section" open={showArchive} onToggle={e => setShowArchive(e.currentTarget.open)}><summary>Прежние планы кабинетов · {state.legacy?.length || 0} · сохранены без изменений</summary><p className="op-muted">Это независимые планы старой страницы. Они не складываются с общим планом автоматически. Для другого месяца измените месяц вверху.</p>{state.legacy?.map(x => <div key={x.shop}><h3>{SH.find(s => s.id === x.shop)?.label || x.shop}</h3><div className="op-scroll"><table className="op-table"><thead><tr><th>Строка</th><th>Выкупы, шт.</th><th>Поступление за выкуп</th><th>Другие сохранённые метрики</th></tr></thead><tbody>{Object.entries(x.plan).map(([p, t]) => <tr key={p}><td>{p}</td><td>{fmt(t.salesQty)}</td><td>{rub(t.payout)}</td><td>{Object.entries(t).filter(([k]) => !['salesQty', 'payout'].includes(k)).map(([k, v]) => `${({ orders: 'Заказы, шт.', revenue: 'Заказы, ₽', sales: 'Выкупы, ₽', profit: 'Прибыль, ₽', margin: 'Маржа, %' })[k] || k}: ${fmt(v)}`).join(' · ')}</td></tr>)}</tbody></table></div></div>)}</details>
  </div>;
}
