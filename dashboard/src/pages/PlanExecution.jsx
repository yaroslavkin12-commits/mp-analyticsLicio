import React from 'react';
import dayjs from 'dayjs';
import { SHOPS } from '../lib/cabinets';
import { planTotal, planActual, inPlanPath, evaluatePlan, resultTone, resultLabel } from '../lib/planEvaluation';
const SH = SHOPS.filter(s => s.platform === 'ozon');
const SEP = ' / ';
const fmt = (v, digits = 0) => v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('ru-RU', { maximumFractionDigits: digits });
const rub = v => v === null || v === undefined ? '—' : `${fmt(v, 2)} ₽`;
const pct = v => v === null || v === undefined ? '—' : `${fmt(v, 1)}%`;
const signed = (v, format = rub) => v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${format(v)}`;
const stamp = v => v ? new Date(v).toLocaleString('ru-RU') : '—';
const prettyDate = v => v ? new Date(v + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
const cellTone = v => resultTone(v) ? `op-result ${resultTone(v)}` : '';
function Score({ value, detail }) {
  return <><span className="n">{pct(value)}</span><small>{resultLabel(value)}</small>{detail && <small>{detail}</small>}</>;
}
function MeanCell({ f, t, score, future }) {
  return <td className={cellTone(score.meanRatio)}>{future ? '—' : rub(f.mean)}<small>{pct(score.meanRatio)} цели · {signed(score.meanDelta)}</small><small>{resultLabel(score.meanRatio)}</small>{!f.complete && !future && <small>Известная часть факта</small>}</td>;
}
function ResultCells({ t, f, score, future, end }) {
  return <>
    <td className="n">{fmt(t.qty)}</td>
    <td className={cellTone(score.qtyPace)}>{future ? '—' : fmt(f.qty)}{score.qtyPace !== null && <small>{resultLabel(score.qtyPace)} на дату</small>}{!f.complete && !future && <small>Неполный факт</small>}</td>
    <td className="n">{pct(score.qtyMonth)}</td>
    <td className={cellTone(score.qtyPace)}><Score value={score.qtyPace} detail={score.qtyForecast !== null ? `Оценка месяца: ${fmt(score.qtyForecast, 1)} шт.` : null} /><small>План на {end}: {fmt(score.qtyExpected, 1)} шт.</small></td>
    <td>{rub(t.mean)}</td>
    <MeanCell f={f} t={t} score={score} future={future} />
    <td>{future ? '—' : rub(f.payout)}<small>План месяца: {rub(t.amount)}</small><small>Выполнено: {pct(score.amountMonth)}</small></td>
    <td className={cellTone(score.amountPace)}><Score value={score.amountPace} detail={score.amountForecast !== null ? `Оценка месяца: ${rub(score.amountForecast)}` : null} /><small>План на дату: {rub(score.amountExpected)}</small></td>
  </>;
}
function Headers({ first }) {
  return <tr><th scope="col">{first}</th><th scope="col">План, шт.</th><th scope="col">Факт, шт.</th><th scope="col">Выполнено за месяц</th><th scope="col">К плану на дату, шт.</th><th scope="col">Цель за выкуп</th><th scope="col">Факт за выкуп</th><th scope="col">Поступило / план месяца</th><th scope="col">К плану суммы на дату</th></tr>;
}
export default function PlanExecution({ month, viewed, paths, fact, shop, path, setPath }) {
  const rows = viewed.rows;
  const selected = rows.filter(r => inPlanPath(r.path, path));
  const t = planTotal(selected, shop), f = planActual(fact, rows, shop, path);
  const days = dayjs(month + '-01').daysInMonth();
  const elapsed = fact.to ? Math.max(0, Math.min(days, dayjs(fact.to).diff(month + '-01', 'day') + 1)) : 0;
  const score = evaluatePlan(t, f, elapsed, days);
  const end = fact.to ? dayjs(fact.to).format('DD.MM') : '—';
  const currentMoscow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(fact.asOf || Date.now()));
  const current = currentMoscow.slice(0, 7) === month;
  const unplanned = paths.filter(p => !rows.some(r => r.path === p));
  const dayItems = Array.from({ length: days }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, '0')}`;
    const f = planActual(fact, selected, shop, '', date);
    const available = !!fact.to && date <= fact.to;
    const daily = { qty: t.qty / days, amount: t.amount / days, mean: t.mean };
    return { date, f, available, t: daily, score: evaluatePlan(daily, { ...f, complete: f.complete && available }, 1, 1) };
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
    {fact.future ? <div className="op-alert">Для этого месяца ещё нет полных финансовых дней с учётом задержки начислений.</div> : <div className="op-alert op-evaluation-note" role="note"><b>Оценка по {prettyDate(fact.to)} включительно</b><p>{current ? `Сегодня ${prettyDate(currentMoscow)} по Москве. Последние три дня исключены из оценки: начисления Ozon поступают с задержкой. ` : ''}Факт и план на дату сравниваются за одинаковые {elapsed} из {days} дней месяца. Среднее за один выкуп сравнивается напрямую с целью, без деления на прошедшие дни.</p><small>Только запланированные подкатегории · обновлено {stamp(fact.asOf)}</small></div>}
    {!!f.issues.length && !fact.future && <div className="op-alert warn"><b>Факт неполный. Проценты выполнения и темпа скрыты.</b><ul>{f.issues.map(x => <li key={x}>{x}</li>)}</ul></div>}
    <div className="op-kpis">
      <div className={`a-kpi ${cellTone(score.qtyPace)}`}><span className="lbl">Выкупы, шт.</span><b className="val n">{fact.future ? '—' : fmt(f.qty)} <small>/ {fmt(t.qty)}</small></b><span className="sub">{f.complete ? resultLabel(score.qtyPace) + ' на дату' : 'Известный факт / план месяца'}</span></div>
      <div className="a-kpi"><span className="lbl">Выполнено за месяц</span><b className="val n">{pct(score.qtyMonth)}</b><div className={`op-progress ${resultTone(score.qtyPace)}`}><i style={{ width: `${Math.min(100, Math.max(0, score.qtyMonth || 0))}%` }} /></div><span className="sub">Доля полного месячного плана</span></div>
      <div className={`a-kpi ${cellTone(score.qtyPace)}`}><span className="lbl">К плану штук на {end}</span><b className="val n">{pct(score.qtyPace)}</b><span className="sub">{resultLabel(score.qtyPace)} · план на дату {fmt(score.qtyExpected, 1)} шт.</span><span className="sub">Оценка месяца: {fmt(score.qtyForecast, 1)} шт.</span></div>
      <div className={`a-kpi ${cellTone(score.meanRatio)}`}><span className="lbl">Поступление за один выкуп</span><b className="val n">{fact.future ? '—' : rub(f.mean)}</b><span className="sub">Цель {rub(t.mean)} · {pct(score.meanRatio)} цели</span><span className="sub">{resultLabel(score.meanRatio)} · отклонение {signed(score.meanDelta)}</span></div>
    </div>
    <section className="a-card op-section" aria-label="Общая сумма поступлений"><h2>Общая сумма поступлений</h2><p className="op-muted">План месяца = плановые штуки × целевое среднее по каждой подкатегории и магазину, без повторного учёта родительских итогов. Сумма поступлений и среднее за выкуп — разные показатели.</p><div className="op-money-kpis">
      <div className={`a-kpi ${cellTone(score.amountPace)}`}><span className="lbl">Поступило по {end}</span><b className="val n">{fact.future ? '—' : rub(f.payout)}</b><span className="sub">План месяца {rub(t.amount)}</span><span className="sub">Выполнено за месяц: {pct(score.amountMonth)}</span></div>
      <div className={`a-kpi ${cellTone(score.amountPace)}`}><span className="lbl">К плану суммы на {end}</span><b className="val n">{pct(score.amountPace)}</b><span className="sub">{resultLabel(score.amountPace)} · ожидалось {rub(score.amountExpected)}</span><span className="sub">Отклонение от плана на дату: {signed(score.amountDelta)}</span></div>
      <div className={`a-kpi ${cellTone(score.amountPace)}`}><span className="lbl">Оценка суммы за месяц</span><b className="val n">{rub(score.amountForecast)}</b><span className="sub">При сохранении среднего дневного темпа по {end}</span><span className="sub">Линейная оценка, не гарантированный результат</span></div>
    </div></section>
    <p className="op-muted op-evaluation-help">Зелёный — план на дату или цель среднего достигнуты, красный — ниже цели. Процент «Выполнено за месяц» сам по себе не означает отставание. Все оценки месяца линейные: факт за {elapsed} дней / {elapsed || '—'} × {days}.</p>
    <section className="a-card op-section"><h2>Результат по категориям</h2><p className="op-muted">В родительских строках учитываются только подкатегории с планом. Сравнение с планом на {prettyDate(fact.to)}.</p><div className="op-scroll"><table className="op-table op-results"><thead><Headers first="Категория" /></thead><tbody>{[...new Set(rows.map(r => r.path.split(SEP)[0]))].filter(p => !path || inPlanPath(path, p) || inPlanPath(p, path)).flatMap(p => {
      const children = rows.filter(r => inPlanPath(r.path, p) && inPlanPath(r.path, path));
      const out = children.length > 1 || children[0]?.path !== p ? [{ key: p, children, parent: true }, ...children.map(r => ({ key: r.path, children: [r] }))] : children.map(r => ({ key: r.path, children: [r] }));
      return out.map(r => { const t = planTotal(r.children, shop), f = planActual(fact, r.children, shop); return <tr key={r.key} className={r.parent ? 'op-parent' : ''}><td className="op-name"><button className="op-link" onClick={() => setPath(r.key)}>{r.parent ? r.key : r.key.split(SEP).at(-1)}</button>{r.parent && <small>План задан: {r.children.length} из {paths.filter(x => inPlanPath(x, r.key)).length}</small>}</td><ResultCells t={t} f={f} score={evaluatePlan(t, f, elapsed, days)} future={fact.future} end={end} /></tr>; });
    })}</tbody></table></div></section>
    <section className="a-card op-section"><h2>Распределение и результат по магазинам</h2><div className="op-scroll"><table className="op-table op-results"><thead><Headers first="Магазин" /></thead><tbody>{SH.filter(s => !shop || s.id === shop).map(s => { const t = planTotal(selected, s.id), f = planActual(fact, selected, s.id); return <tr key={s.id}><td>{s.label}<small>{fact.shops[s.id]?.error || (fact.shops[s.id]?.partial ? 'Неполный период' : `Сбор ${stamp(fact.shops[s.id]?.updatedAt)}`)}</small></td><ResultCells t={t} f={f} score={evaluatePlan(t, f, elapsed, days)} future={fact.future} end={end} /></tr>; })}</tbody></table></div></section>
    {!!unplanned.length && <details className="a-card op-section"><summary>Без плана · {unplanned.length} категорий — исключены из выполнения</summary><p>{unplanned.join(' · ')}</p></details>}
    <section className="a-card op-section"><h2>По дням · {path || 'Запланированные категории'} · {shop ? SH.find(s => s.id === shop)?.label : 'Весь Ozon'}</h2><p className="op-muted">План штук и общей суммы равномерный по дням. Среднее за выкуп сравнивается с полной целью. Дни после {end} ещё не оцениваются.</p><div className="op-scroll op-day-scroll" tabIndex={0} role="region" aria-label="Показатели по дням, горизонтальная прокрутка"><table className="op-table op-days" style={{ '--op-days-count': days }}><colgroup><col className="op-day-label" /><col span={days} /></colgroup><thead><tr><th scope="col">Показатель</th>{dayItems.map(d => <th scope="col" key={d.date}>{dayjs(d.date).format('DD.MM')}</th>)}</tr></thead><tbody>{dayRows.map(row => <tr key={row.label}><th scope="row">{row.label}</th>{dayItems.map(d => { const tone = !row.planned && d.available && row.tone ? row.tone(d) : null; return <td key={d.date} className={cellTone(tone)}>{row.planned || d.available ? <>{row.value(d)}{row.detail && <small>{row.detail(d)}</small>}{row.status && <small>{resultLabel(tone)}</small>}</> : '—'}</td>; })}</tr>)}</tbody></table></div></section>
  </>;
}
