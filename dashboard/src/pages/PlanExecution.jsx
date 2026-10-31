import React from 'react';
import PlanDashboard from './PlanDashboard';
import dayjs from 'dayjs';
import { SHOPS } from '../lib/cabinets';
import { planTotal, planActual, inPlanPath, evaluatePlan, resultTone } from '../lib/planEvaluation';
const DEFAULT_SH = SHOPS.filter(s => s.platform === 'ozon');
const SEP = ' / ';
const fmt = (v, digits = 0) => v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('ru-RU', { maximumFractionDigits: digits });
const rub = v => v === null || v === undefined ? '—' : `${fmt(v, 2)} ₽`;
const pct = v => v === null || v === undefined ? '—' : `${fmt(v, 1)}%`;
const signed = (v, format = rub) => v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${format(v)}`;
const stamp = v => v ? new Date(v).toLocaleString('ru-RU') : '—';
const prettyDate = v => v ? new Date(v + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
const cellTone = v => resultTone(v) ? `op-result ${resultTone(v)}` : '';
export default function PlanExecution({ shops: SH = DEFAULT_SH, groupLabel = 'Весь Ozon', month, viewed, paths, fact, shop, path }) {
  const rows = viewed.rows;
  const selected = rows.filter(r => inPlanPath(r.path, path));
  const t = planTotal(selected, shop), f = planActual(fact, rows, shop, path);
  const days = dayjs(month + '-01').daysInMonth();
  const elapsed = fact.elapsedDays ?? (fact.to ? Math.max(0, Math.min(days, dayjs(fact.to).diff(month + '-01', 'day') + 1)) : 0);
  const unplanned = paths.filter(p => !rows.some(r => r.path === p));
  const dayItems = Array.from({ length: days }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, '0')}`;
    const f = planActual(fact, selected, shop, '', date);
    const available = !!fact.to && date <= fact.to;
    const daily = { qty: t.qty / days, amount: t.amount / days, mean: t.mean };
    return { date, f, available, t: daily, score: evaluatePlan(daily, { ...f, complete: f.complete && available && !(fact.provisional && date === fact.to) }, 1, 1) };
  });
  const dayRows = [
    { label: 'План выкупов, шт.', value: d => fmt(d.t.qty, 1), planned: true },
    { label: 'Факт выкупов, шт.', value: d => fmt(d.f.qty), tone: d => d.score.qtyPace, status: true },
    { label: 'Выкупы · выполнение дня', value: d => pct(d.score.qtyPace), tone: d => d.score.qtyPace, status: true },
    { label: 'Цель за выкуп, ₽', value: d => rub(d.t.mean), planned: true },
    { label: 'Факт за выкуп, ₽', value: d => rub(d.f.mean), tone: d => d.score.meanRatio, detail: d => `${pct(d.score.meanRatio)} цели · ${signed(d.score.meanDelta)}`, status: true },
    { label: 'План поступлений дня, ₽', value: d => rub(d.t.amount), planned: true },
    { label: 'Поступило за день, ₽', value: d => rub(d.f.payout), tone: d => d.score.amountPace, status: true },
    { label: 'Сумма · выполнение дня', value: d => pct(d.score.amountPace), tone: d => d.score.amountPace, status: true },
  ];
  return <>
    {fact.future ? <div className="op-alert">Для этого месяца ещё нет данных.</div> : !fact.to ? <div className="op-alert">Финансы за выбранный месяц ещё не загружены.</div> : <div className="op-data-note" role="note"><span>Данные по <b>{prettyDate(fact.to)}</b>{fact.provisional ? ' · предварительно' : ''} · общие загруженные финансовые дни</span><small>Обновлено {stamp(fact.asOf)}</small></div>}
    {!!f.issues.length && !fact.future && <div className="op-alert warn"><b>Факт неполный. Проценты выполнения и темпа скрыты.</b><ul>{f.issues.map(x => <li key={x}>{x}</li>)}</ul></div>}
    <PlanDashboard shops={SH} rows={rows} fact={fact} month={month} shop={shop} path={path} elapsed={elapsed} days={days} />
    {!!unplanned.length && <details className="a-card op-section"><summary>Без плана · {unplanned.length} категорий — исключены из выполнения</summary><p>{unplanned.join(' · ')}</p></details>}
    <details className="a-card op-section"><summary>По дням · {path || 'Запланированные категории'} · {shop?.startsWith('market:')?(shop==='market:wb'?'Wildberries':'Ozon'):shop?SH.find(s=>s.id===shop)?.label:groupLabel}</summary><p className="op-muted">План штук и общей суммы равномерный по дням. Среднее за выкуп сравнивается с полной целью. Текущий день предварительный и не получает цветовую оценку; будущие дни не оцениваются.</p><div className="op-scroll op-day-scroll" tabIndex={0} role="region" aria-label="Показатели по дням, горизонтальная прокрутка"><table className="op-table op-days" style={{ '--op-days-count': days }}><colgroup><col className="op-day-label" /><col span={days} /></colgroup><thead><tr><th scope="col">Показатель</th>{dayItems.map(d => <th scope="col" key={d.date}>{dayjs(d.date).format('DD.MM')}</th>)}</tr></thead><tbody>{dayRows.map(row => <tr key={row.label}><th scope="row">{row.label}</th>{dayItems.map(d => { const tone = !row.planned && d.available && row.tone ? row.tone(d) : null; return <td key={d.date} className={cellTone(tone)}>{row.planned || d.available ? <>{row.value(d)}{row.detail && <small>{row.detail(d)}</small>}</> : '—'}</td>; })}</tr>)}</tbody></table></div></details>
  </>;
}
