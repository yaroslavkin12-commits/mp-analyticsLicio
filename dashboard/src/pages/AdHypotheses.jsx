import React, { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { addAdHypothesis, finishAdHypothesis, getAdHypotheses, removeAdHypothesis, reorderAdHypotheses } from '../api';

const GOALS = {
  ctr: 'Рост CTR', crToCart: 'Рост CR в корзину', crToOrder: 'Рост CR в заказ',
  drr: 'Снижение ДРР', spend: 'Снижение рекламного бюджета', profitF: 'Рост прогнозируемой прибыли',
  orders: 'Рост заказов', payoutPerBuyoutF: 'Рост поступления на счёт с выкупа', custom: 'Другая цель',
};
const VERDICTS = { worked: 'Сработала', failed: 'Не сработала', unclear: 'Недостаточно данных' };
const goalOf = row => row.goal === 'custom' ? row.customGoal : GOALS[row.goal];
const dateLabel = date => dayjs(date).format('DD.MM.YY');
const moscowToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
const fmt = (value, digits) => value.toLocaleString('ru-RU', { maximumFractionDigits: digits });

function Comparison({ goal, data }) {
  const percent = ['ctr', 'crToCart', 'crToOrder', 'drr'].includes(goal);
  const unit = percent ? '%' : goal === 'orders' ? ' шт.' : ' ₽';
  const diff = data.during - data.before;
  return <div className="ah-comparison">
    <strong>{fmt(data.before, 2)}{unit} → {fmt(data.during, 2)}{unit}</strong>
    <span>{diff > 0 ? '+' : ''}{fmt(diff, 2)}{percent ? ' п. п.' : unit} к предыдущему периоду той же длины</span>
  </div>;
}

function CreateHypothesis({ onSave, onCancel, busy, today }) {
  const [goal, setGoal] = useState('ctr');
  const [start, setStart] = useState(today);
  return <form className="ah-form" onSubmit={event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    onSave({ ...values, plannedEnd: values.plannedEnd || null });
  }}>
    <label className="ah-wide">Гипотеза<input className="a-input" name="title" required maxLength={140} placeholder="Что хотим проверить" /></label>
    <label>Начало теста<input className="a-input" name="start" type="date" required value={start} onChange={event => setStart(event.target.value)} /></label>
    <label>Плановый конец (необязательно)<input className="a-input" name="plannedEnd" type="date" min={start} /></label>
    <label className="ah-wide">Цель<select className="a-input" name="goal" value={goal} onChange={event => setGoal(event.target.value)}>
      {Object.entries(GOALS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    {goal === 'custom' && <label className="ah-wide">Своя цель<input className="a-input" name="customGoal" required maxLength={100} /></label>}
    <label className="ah-wide">Что меняем<textarea className="a-input" name="description" rows={3} maxLength={5000} placeholder="Опишите изменения и условия теста" /></label>
    <div className="ah-actions ah-wide">
      <button type="submit" className="a-btn" disabled={busy}>Сохранить</button>
      <button type="button" className="a-btn ghost" onClick={onCancel} disabled={busy}>Отмена</button>
    </div>
  </form>;
}

function FinishHypothesis({ row, onSave, onCancel, busy, compare, today }) {
  const yesterday = dayjs(today).subtract(1, 'day').format('YYYY-MM-DD');
  const defaultEnd = row.plannedEnd && row.plannedEnd < today ? row.plannedEnd : yesterday;
  const [end, setEnd] = useState(defaultEnd < row.start ? row.start : defaultEnd);
  const [preview, setPreview] = useState(null);
  const ready = preview?.end === end;
  const custom = row.goal === 'custom';
  useEffect(() => {
    if (custom || !end || end < row.start || end >= today) return;
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const data = await compare(row, end);
        if (current) setPreview({ end, data });
      } catch {
        if (current) setPreview({ end, error: true });
      }
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [row, end, custom, compare, today]);
  const pending = !custom && end >= row.start && end < today && !ready;
  return <form className="ah-form" onSubmit={event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    onSave({ ...values, comparison: ready ? preview.data : null });
  }}>
    <label>Дата завершения<input className="a-input" name="end" type="date" required min={row.start} max={today} value={end} onChange={event => setEnd(event.target.value)} /></label>
    <label>Результат<select className="a-input" name="verdict" required defaultValue="">
      <option value="" disabled>Выберите оценку</option>
      {Object.entries(VERDICTS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    <div className="ah-wide" aria-live="polite">
      {custom ? <span className="a-hint">Для своей цели оценку можно записать в выводе.</span>
        : ready && preview.data ? <Comparison goal={row.goal} data={preview.data} />
          : <span className="a-hint">{end === today ? 'Данные за сегодня ещё неполные.'
            : pending ? 'Загружаем сравнение…'
              : ready && preview.error ? 'Не удалось загрузить сравнение. Итог можно записать вручную.'
                : 'Недостаточно данных для сравнения.'}</span>}
    </div>
    <label className="ah-wide">Вывод<textarea className="a-input" name="note" rows={3} maxLength={5000} placeholder="Что оставляем или проверяем дальше" /></label>
    <div className="ah-actions ah-wide">
      <button type="submit" className="a-btn" disabled={busy || pending}>Сохранить итог</button>
      <button type="button" className="a-btn ghost" onClick={onCancel} disabled={busy}>Назад</button>
    </div>
  </form>;
}

export default function AdHypotheses({ cabinet, offerId, mode, compare, marked, onMarked, onSelection }) {
  const [rows, setRows] = useState(null);
  const [selected, setSelected] = useState(null);
  const [dragged, setDragged] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [form, setForm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const row = rows?.find(item => item.id === selected) || rows?.find(item => !item.end) || rows?.[0];
  const today = moscowToday();
  useEffect(() => {
    let current = true;
    getAdHypotheses(cabinet, offerId).then(({ data }) => {
      if (current) setRows(data.data);
    }).catch(() => { if (current) setError('Не удалось загрузить гипотезы'); });
    return () => { current = false; };
  }, [cabinet, offerId, attempt]);
  useEffect(() => { onSelection(row || null); }, [row, onSelection]);

  async function save(values) {
    setBusy(true);
    setError('');
    try {
      const { data } = form === 'create'
        ? await addAdHypothesis(cabinet, offerId, { ...values, mode })
        : await finishAdHypothesis(cabinet, offerId, row.id, values);
      const saved = data.data;
      setRows(items => form === 'create' ? [saved, ...items] : items.map(item => item.id === saved.id ? saved : item));
      setSelected(saved.id);
      setForm('');
    } catch (error) {
      setError(error.response?.data?.error || 'Не удалось сохранить гипотезу');
    } finally { setBusy(false); }
  }

  async function remove(item) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await removeAdHypothesis(cabinet, offerId, item.id);
      setRows(items => items.filter(entry => entry.id !== item.id));
      setConfirmDelete(null);
      if (row?.id === item.id) { setSelected(null); setForm(''); }
    } catch (error) {
      setError(error.response?.data?.error || 'Не удалось удалить гипотезу');
      if (error.response?.status === 404) setAttempt(n => n + 1);
    } finally { setBusy(false); }
  }

  async function move(from, to) {
    if (busy || from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return;
    const next = [...rows];
    next.splice(to, 0, next.splice(from, 1)[0]);
    setBusy(true);
    setError('');
    try {
      await reorderAdHypotheses(cabinet, offerId, next.map(item => item.id));
      setRows(next);
    } catch (error) {
      setError(error.response?.data?.error || 'Не удалось изменить порядок');
      if (error.response?.status === 409) setAttempt(n => n + 1);
    } finally { setBusy(false); }
  }

  return <section className="a-box ah-panel">
    <h4>Тестируемые гипотезы
      <button type="button" className="a-btn" onClick={() => { setError(''); setForm('create'); }} disabled={!rows || busy}>+ Гипотеза</button>
    </h4>
    {error && <div role="alert" className="ah-error">{error}{!rows && <button type="button" className="a-btn" onClick={() => { setError(''); setAttempt(n => n + 1); }}>Повторить</button>}</div>}
    {!rows && !error && <span className="a-hint">Загрузка…</span>}
    {form === 'create' && <CreateHypothesis onSave={save} onCancel={() => setForm('')} busy={busy} today={today} />}
    {row && form !== 'create' && <div className={`ah-detail ah-result-${row.verdict || 'active'}`}>
      <div className="ah-heading"><b>{row.end ? 'Результат теста' : goalOf(row)}</b><span className="a-hint">{row.mode === 'ads' ? 'Заказы с рекламы' : 'Все заказы товара'}</span></div>
      {row.description && <p>{row.description}</p>}
      {row.end ? <>
        <b>{VERDICTS[row.verdict]}</b>
        {row.comparison && <Comparison goal={row.goal} data={row.comparison} />}
        {row.note && <p>{row.note}</p>}
      </> : form === 'finish'
        ? <FinishHypothesis row={row} onSave={save} onCancel={() => setForm('')} busy={busy} compare={compare} today={today} />
        : <button type="button" className="a-btn" disabled={row.start > today} onClick={() => { setError(''); setForm('finish'); }}>Завершить тест</button>}
    </div>}
    {row && <label className="a-toggle ah-marks"><input type="checkbox" checked={marked} onChange={event => onMarked(event.target.checked)} />Отметки теста на графике и в таблице</label>}
    {rows?.length === 0 && !form && <span className="a-hint">Гипотез пока нет</span>}
    <div className="ah-history" aria-label="История гипотез">
      {rows?.map((item, index) => (
        <div key={item.id} className={`ah-history-row ah-result-${item.verdict || 'active'}${dragged === item.id ? ' dragging' : ''}`}
          onDragOver={event => { if (dragged && !busy) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
          onDrop={event => { if (!dragged) return; event.preventDefault(); move(rows.findIndex(entry => entry.id === dragged), index); setDragged(null); }}>
          <span className="ah-handle" aria-hidden="true" title="Перетащить гипотезу" draggable={!busy && rows.length > 1}
            onDragStart={event => { setDragged(item.id); event.dataTransfer.setData('text/plain', item.id); event.dataTransfer.effectAllowed = 'move'; }}
            onDragEnd={() => setDragged(null)}>⠿</span>
          <button type="button" aria-pressed={item.id === row?.id} disabled={busy}
            className="ah-history-item" onClick={() => { setSelected(item.id); setForm(''); setError(''); }}>
            <span className={`ah-dot ${item.end ? 'finished' : item.start > today ? 'planned' : ''}`} aria-hidden="true" />
            <span><b>{item.title}</b><small>{dateLabel(item.start)}{item.end ? ` — ${dateLabel(item.end)}` : item.plannedEnd ? ` · план до ${dateLabel(item.plannedEnd)}` : ''}
              {' · '}{item.end ? `Завершена · ${VERDICTS[item.verdict]}` : item.start > today ? 'Запланирована' : 'В тесте'}{' · '}{goalOf(item)}</small></span>
          </button>
          <span className="ah-history-actions">
            {confirmDelete === item.id ? <>
              <button type="button" disabled={busy} className="ah-delete" onClick={() => remove(item)}>Удалить</button>
              <button type="button" disabled={busy} onClick={() => setConfirmDelete(null)}>Отмена</button>
            </> : <>
            {rows.length > 1 && <>
              <button type="button" disabled={busy || index === 0} aria-label={`Поднять «${item.title}»`} title="Выше" onClick={() => move(index, index - 1)}>↑</button>
              <button type="button" disabled={busy || index === rows.length - 1} aria-label={`Опустить «${item.title}»`} title="Ниже" onClick={() => move(index, index + 1)}>↓</button>
            </>}
            <button type="button" disabled={busy} aria-label={`Удалить «${item.title}»`} title="Удалить гипотезу" onClick={() => setConfirmDelete(item.id)}>×</button>
            </>}
          </span>
        </div>
      ))}
    </div>
  </section>;
}
