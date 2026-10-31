import React, { useState } from 'react';
import dayjs from 'dayjs';
import { categoryCompare } from '../components/CategoryNav';
import { inPlanPath, inPlanShop, planTotal, planActual, evaluatePlan, resultTone } from '../lib/planEvaluation';

const fmt = (v, digits = 0) => Number.isFinite(v) ? v.toLocaleString('ru-RU', { maximumFractionDigits: digits }) : '—';
const rub = v => Number.isFinite(v) ? `${fmt(v)} ₽` : '—';
const pct = v => Number.isFinite(v) ? `${fmt(v, 1)}%` : '—';
const signed = (v, money = false) => Number.isFinite(v) ? `${v > 0 ? '+' : ''}${money ? rub(v) : fmt(v)}` : '—';
const readActual = (fact, ...args) => {
  const value = planActual(fact, ...args);
  return fact.future ? { ...value, qty: null, payout: null, mean: null } : value;
};
const marketLabel = id => id === 'wb' ? 'Wildberries' : 'Ozon';
const marketColor = id => id === 'wb' ? 'var(--a-accent)' : '#3887ff';

function Progress({ value, tone }) {
  return <div className={`op-meter ${tone || ''}`}><span><i style={{ width: `${Math.max(0, Math.min(100, value || 0))}%` }} /></span><b>{pct(value)}</b></div>;
}
function Stat({ label, value, tone, title }) {
  return <div className={`op-stat ${tone || ''}`} title={title}><span>{label}</span><b>{value}</b></div>;
}
function Trend({ kind, points, total, score, days, elapsed, to }) {
  const [hover, setHover] = useState(null);
  const mean = kind === 'mean';
  const goal = mean ? total.mean : total.qty;
  const values = points.map(p => mean ? p.mean : p.qty);
  const forecast = mean ? points.at(-1)?.mean : score.qtyForecast;
  const known = [...values, goal, forecast].filter(Number.isFinite);
  let lo = mean && known.length ? Math.min(...known) : 0;
  let hi = known.length ? Math.max(...known) : 1;
  const pad = Math.max((hi - lo) * .16, Math.abs(hi) * .04, 1);
  lo = mean ? lo - pad : Math.min(0, lo); hi += pad;
  const x = day => 62 + (day - 1) / Math.max(1, days - 1) * 496;
  const y = v => 126 - (v - lo) / (hi - lo) * 106;
  const line = items => items.filter(p => Number.isFinite(p.v)).map((p, i) => `${i ? 'L' : 'M'}${x(p.d)},${y(p.v)}`).join(' ');
  const last = points.at(-1), lastVal = mean ? last?.mean : last?.qty, cutoffDay = last?.day || 1;
  const canForecast = Number.isFinite(score.qtyForecast) && Number.isFinite(lastVal) && Number.isFinite(forecast) && elapsed < days;
  const active = hover === null ? null : points[hover];
  const labels = [1, ...Array.from({ length: Math.floor((days - 1) / 5) }, (_, i) => (i + 1) * 5), days];
  return <div className="op-trend"><h3>{mean ? 'Среднее поступление' : 'Накопительные выкупы'} <span>план / факт / прогноз</span></h3><div className="op-chart-area">
    <svg viewBox="0 0 580 158" role="img" aria-label={mean ? 'График среднего поступления за один выкуп' : 'График накопительных выкупов'} onMouseLeave={() => setHover(null)}>
      {[0, 1, 2, 3].map(i => { const v = lo + (hi - lo) * i / 3; return <g key={i}><line x1="62" x2="558" y1={y(v)} y2={y(v)} className="op-chart-grid" /><text x="53" y={y(v) + 3} textAnchor="end">{fmt(v)}</text></g>; })}
      {labels.map(d => <text key={d} x={x(d)} y="149" textAnchor="middle">{d}</text>)}
      {Number.isFinite(goal) && goal > 0 && <path className="op-chart-plan" d={line([{ d: 1, v: mean ? goal : goal / days }, { d: days, v: goal }])} />}
      <path className="op-chart-fact" d={line(points.map(p => ({ d: p.day, v: mean ? p.mean : p.qty })))} />
      {canForecast && <path className="op-chart-forecast" d={line([{ d: cutoffDay, v: lastVal }, { d: days, v: forecast }])} />}
      {Number.isFinite(lastVal) && <><line className="op-chart-cutoff" x1={x(cutoffDay)} x2={x(cutoffDay)} y1="14" y2="126" /><circle className="op-chart-point" cx={x(cutoffDay)} cy={y(lastVal)} r="3.5" /></>}
      {active && Number.isFinite(mean ? active.mean : active.qty) && <circle className="op-chart-point" cx={x(active.day)} cy={y(mean ? active.mean : active.qty)} r="5" />}
      {points.map((p, i) => <rect key={p.day} x={x(p.day) - 496 / days / 2} y="10" width={496 / days} height="122" fill="transparent" onMouseEnter={() => setHover(i)}><title>{p.date}: {mean ? rub(p.mean) : `${fmt(p.qty)} шт.`}</title></rect>)}
    </svg>
    {active && <div className="op-chart-tooltip">{dayjs(active.date).format('DD.MM')} · {mean ? rub(active.mean) : `${fmt(active.qty)} шт.`}</div>}
    {!points.length && <div className="op-chart-empty">Пока нет фактических данных</div>}
    </div><div className="op-chart-legend"><span className="plan">План</span><span className="fact">Факт</span><span className="forecast">Прогноз</span>{to && <small>Данные по {dayjs(to).format('DD.MM')}</small>}</div></div>;
}
function TableCells({ t, f, score, empty }) {
  const qtyDelta = Number.isFinite(score.qtyMonth) ? f.qty - t.qty : null;
  return <><td>{empty ? '—' : fmt(t.qty)}</td><td>{fmt(f.qty)}</td><td><span className={`op-badge ${resultTone(score.qtyPace)}`} title="Цвет — относительно плана на загруженную дату">{pct(score.qtyMonth)}</span></td><td className={resultTone(qtyDelta === null ? null : qtyDelta >= 0 ? 100 : 0)}>{signed(qtyDelta)}</td><td><Progress value={score.qtyMonth} /></td><td>{rub(t.mean)}</td><td>{rub(f.mean)}</td><td><span className={`op-badge ${resultTone(score.meanRatio)}`}>{pct(score.meanRatio)}</span></td><td className={resultTone(score.meanRatio)}>{signed(score.meanDelta, true)}</td><td><Progress value={score.meanRatio} tone={resultTone(score.meanRatio)} /></td></>;
}
export default function PlanDashboard({ shops, rows, fact, month, shop, path, elapsed, days, empty = false }) {
  const [view, setView] = useState('assortment'), [collapsed, setCollapsed] = useState(new Set());
  const selected = rows.filter(r => inPlanPath(r.path, path));
  const total = planTotal(selected, shop), actual = readActual(fact, selected, shop);
  const score = evaluatePlan(total, actual, elapsed, days);
  const markets = [...new Set(shops.filter(s => inPlanShop(s, shop)).map(s => s.platform))];
  const marketData = markets.map(id => {
    const filter = shop && !shop.startsWith('market:') ? shop : `market:${id}`;
    const t = planTotal(selected, filter), f = readActual(fact, selected, filter);
    return { id, t, f, score: evaluatePlan(t, f, elapsed, days), share: total.qty > 0 ? t.qty / total.qty * 100 : null };
  });
  let qty = 0, payout = 0;
  const points = Array.from({ length: fact.to && !fact.future ? Math.min(days, dayjs(fact.to).date()) : 0 }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, '0')}`, f = readActual(fact, selected, shop, '', date);
    if (Number.isFinite(f.qty)) qty += f.qty;
    if (Number.isFinite(f.payout)) payout += f.payout;
    return { day: i + 1, date, qty: Number.isFinite(f.qty) ? qty : null, mean: qty > 0 ? payout / qty : null };
  });
  const toggle = key => setCollapsed(old => { const next = new Set(old); next.has(key) ? next.delete(key) : next.add(key); return next; });
  const renderRow = (key, label, subset, filter, depth, children, totalRow = false) => {
    const t = planTotal(subset, filter), f = readActual(fact, subset, filter), s = evaluatePlan(t, f, elapsed, days);
    return <tr key={key} className={totalRow ? 'op-total-row' : children ? 'op-tree-parent' : ''}><th scope="row"><div className="op-tree-label" style={{ paddingLeft: depth * 18 }}>{children ? <button aria-expanded={!collapsed.has(key)} aria-label={`${collapsed.has(key) ? 'Развернуть' : 'Свернуть'} ${label}`} onClick={() => toggle(key)}>{collapsed.has(key) ? '›' : '⌄'}</button> : <i />}{label}</div></th><TableCells t={t} f={f} score={s} empty={empty} /></tr>;
  };
  const shopRows = (prefix, subset, platform, depth) => shops.filter(s => inPlanShop(s, shop) && (!platform || s.platform === platform)).map(s => renderRow(`${prefix}:${s.id}`, s.label, subset, s.id, depth, false));
  const platformRows = (prefix, subset, depth) => markets.flatMap(id => {
    const key = `${prefix}:market:${id}`, filter = shop && !shop.startsWith('market:') ? shop : `market:${id}`;
    return [renderRow(key, marketLabel(id), subset, filter, depth, true), ...(!collapsed.has(key) ? shopRows(key, subset, id, depth + 1) : [])];
  });
  const tree = (parent = '', depth = 0) => [...new Set(selected.filter(r => inPlanPath(r.path, parent)).map(r => r.path.split(' / ').slice(0, depth + 1).join(' / ')))].sort(categoryCompare).flatMap(p => {
    const subset = selected.filter(r => inPlanPath(r.path, p));
    const leaf = subset.length === 1 && subset[0].path === p, key = `path:${p}`;
    return [renderRow(key, p.split(' / ').at(-1), subset, shop, depth, true), ...(!collapsed.has(key) ? leaf ? platformRows(key, subset, depth + 1) : tree(p, depth + 1) : [])];
  });
  const qtyDelta = Number.isFinite(score.qtyMonth) ? actual.qty - total.qty : null;
  return <>
    <div className="op-dashboard-grid">
      <section className="a-card op-metric-panel" aria-label="Выкупы, шт."><div className="op-metric-summary"><h2>Выкупы, шт.</h2><div className="op-stat-grid"><Stat label="План" value={empty ? '—' : `${fmt(total.qty)} шт.`} /><Stat label="Факт" value={Number.isFinite(actual.qty) ? `${fmt(actual.qty)} шт.` : '—'} /><Stat label="Выполнение" value={pct(score.qtyMonth)} tone={resultTone(score.qtyPace)} title="Доля месячного плана. Цвет — по темпу выполнения на загруженную дату." /><Stat label="Δ к плану месяца" value={Number.isFinite(qtyDelta) ? `${signed(qtyDelta)} шт.` : '—'} tone={resultTone(qtyDelta === null ? null : qtyDelta >= 0 ? 100 : 0)} /><Stat label="Прогноз месяца" value={Number.isFinite(score.qtyForecast) ? `${fmt(score.qtyForecast)} шт.` : '—'} /></div><p className="op-metric-foot">На дату: {pct(score.qtyPace)} · ожидалось {fmt(score.qtyExpected)} шт.</p></div><Trend kind="qty" points={points} total={total} score={score} days={days} elapsed={elapsed} to={fact.to} /></section>
      <section className="a-card op-market-panel" aria-label="Распределение плана выкупов"><h2>Распределение плана выкупов</h2><div className="op-market-stack">{marketData.map(m => m.share > 0 && <span key={m.id} style={{ width: `${m.share}%`, background: marketColor(m.id) }} title={`${marketLabel(m.id)}: ${fmt(m.t.qty)} шт. · ${pct(m.share)}`}>{m.share >= 12 ? pct(m.share) : ''}</span>)}</div><div className="op-market-legend">{marketData.map(m => <div key={m.id}><i style={{ background: marketColor(m.id) }} /><span>{marketLabel(m.id)}</span><b>{empty ? '—' : `${fmt(m.t.qty)} шт.`} <small>/ {pct(m.share)}</small></b></div>)}</div></section>
      <section className="a-card op-metric-panel" aria-label="Среднее поступление на счёт за один выкуп"><div className="op-metric-summary"><h2>Среднее поступление на счёт за один выкуп</h2><div className="op-stat-grid"><Stat label="План" value={rub(total.mean)} /><Stat label="Факт" value={rub(actual.mean)} /><Stat label="Выполнение" value={pct(score.meanRatio)} tone={resultTone(score.meanRatio)} /><Stat label="Δ к плану" value={signed(score.meanDelta, true)} tone={resultTone(score.meanRatio)} /><Stat label="Прогноз месяца" value={Number.isFinite(score.qtyForecast) ? rub(actual.mean) : '—'} title="При сохранении текущего среднего поступления за выкуп" /></div><p className="op-metric-foot">Поступило {rub(actual.payout)} / план месяца {empty ? '—' : rub(total.amount)} · прогноз суммы {rub(score.amountForecast)}</p></div><Trend kind="mean" points={points} total={total} score={score} days={days} elapsed={elapsed} to={fact.to} /></section>
      <section className="a-card op-market-panel" aria-label="Среднее поступление по площадкам"><h2>Среднее поступление Ozon / WB</h2><div className="op-market-means">{marketData.map(m => <div key={m.id}><div className="op-market-mean-label"><b>{marketLabel(m.id)}</b><span>Факт: <strong>{rub(m.f.mean)}</strong></span><span>План: {rub(m.t.mean)}</span><span className={`op-badge ${resultTone(m.score.meanRatio)}`}>{pct(m.score.meanRatio)}</span></div><div className="op-target-meter"><i style={{ width: `${Math.max(0, Math.min(100, (m.score.meanRatio || 0) / 1.2))}%`, background: marketColor(m.id) }} />{m.t.mean > 0 && <b title="Цель 100%" />}</div></div>)}</div></section>
    </div>
    <section className="a-card op-unified-section" aria-label="Выполнение плана по ассортименту и площадкам"><div className="op-section-head"><div className="op-view-switch" role="group" aria-label="Разрез таблицы"><button className={view === 'assortment' ? 'active' : ''} onClick={() => setView('assortment')}>По ассортименту</button><button className={view === 'markets' ? 'active' : ''} onClick={() => setView('markets')}>По площадкам</button></div><span className="op-muted">Δ — к плану месяца · цвет выполнения — по плану на дату</span></div><div className="op-scroll"><table className="op-table op-unified"><thead><tr><th rowSpan="2" scope="col">Наименование</th><th colSpan="5" scope="colgroup">Выкупы, шт.</th><th colSpan="5" scope="colgroup">Среднее поступление, ₽ / выкуп</th></tr><tr>{['План', 'Факт', 'Выполнение', 'Δ к плану, шт.', 'Прогресс', 'План', 'Факт', 'Выполнение', 'Δ к плану, ₽', 'Прогресс'].map((label, i) => <th key={i} scope="col">{label}</th>)}</tr></thead><tbody>{renderRow('total', 'Итого по выбранным кабинетам', selected, shop, 0, false, true)}{view === 'assortment' ? tree() : platformRows('all', selected, 0)}</tbody></table></div>{empty && <p className="op-muted op-empty-table">Задайте цели в «Настроить план» — здесь появится выполнение по подкатегориям, площадкам и кабинетам.</p>}</section>
  </>;
}
