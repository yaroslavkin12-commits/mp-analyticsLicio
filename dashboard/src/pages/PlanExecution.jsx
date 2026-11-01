import React from 'react';
import dayjs from 'dayjs';
import PlanDashboard from './PlanDashboard';

export default function PlanExecution({ shops, month, viewed, fact, shop, path }) {
  const days = dayjs(month + '-01').daysInMonth();
  const elapsed = fact.elapsedDays ?? (fact.to ? Math.max(0, Math.min(days, dayjs(fact.to).diff(month + '-01', 'day') + 1)) : 0);
  return <>
    {fact.to && <div className="op-data-note"><span>Данные по <b>{dayjs(fact.to).format('DD.MM.YYYY')}</b>{fact.provisional ? ' · предварительно' : ''}</span><small>{fact.asOf ? `Обновлено ${new Date(fact.asOf).toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'})}` : ''}</small></div>}
    <PlanDashboard shops={shops} rows={viewed.rows} fact={fact} month={month} shop={shop} path={path} elapsed={elapsed} days={days} />
  </>;
}
