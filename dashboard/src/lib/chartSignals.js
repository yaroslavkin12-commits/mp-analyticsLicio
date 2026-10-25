// Экспериментальная окраска временных столбцов. Значения не изменяются.
const lower = /^(spend|expense|ads|avgCpc|adCpo|cpo|drr|position|commission|logistics|returns|cancel)/i;
export const isRateMetric = key => /^(avg|paySale|payForecast|margin|ctr|crTo|drr|position|buyoutRate|cpo|adCpo|roi|stock)/i.test(key);
const color = { good: 'var(--a-good, #16804a)', warn: 'var(--a-warn, #a86400)', bad: 'var(--a-bad, #c4321f)', pending: 'var(--a-ink3, #7d8798)' };
export function barSignals(values, { dates = [], gran = 'day', metric = '', durations = [], pending = [], direction } = {}) {
  const negativeCosts = lower.test(metric) && values.some(v => v < 0) && values.every(v => v == null || v <= 0);
  const dir = direction || (lower.test(metric) && !negativeCosts ? 'down' : 'up');
  return values.map((v, i) => {
    const result = (status, text, pct = null, base = null) => ({ status, color: color[status], text, pct, base });
    if (!Number.isFinite(v) || pending[i]) return result('pending', pending[i] ? 'Незавершённый период: оценка уточняется' : 'Нет данных');
    let j = i - 1, sameWeekday = false;
    if (gran === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(dates[i] || '')) {
      const d = new Date(dates[i] + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 7);
      const found = dates.indexOf(d.toISOString().slice(0, 10));
      if (found >= 0) { j = found; sameWeekday = true; }
    }
    if (j < 0 || !Number.isFinite(values[j]) || pending[j]) return result('pending', 'Нет сопоставимого предыдущего периода');
    const perDay = !isRateMetric(metric) && durations[i] > 0 && durations[j] > 0;
    const a = perDay ? v / durations[i] : v, b = perDay ? values[j] / durations[j] : values[j];
    const pct = b === 0 ? (a === 0 ? 0 : null) : (a - b) / Math.abs(b) * 100;
    const change = pct === null ? Math.sign(a - b) * 100 : pct;
    const signed = dir === 'down' ? -change : change;
    const status = Math.abs(change) <= 5 ? 'warn' : signed > 0 ? 'good' : 'bad';
    const delta = pct === null ? `с ${b} до ${a}` : `${pct >= 0 ? '+' : ''}${pct.toFixed(1).replace('.', ',')}%`;
    return result(status, `${delta} ${sameWeekday ? 'к тому же дню прошлой недели' : 'к предыдущему периоду'}${perDay ? ' (в среднем за день)' : ''}. ${dir === 'down' ? 'Снижение показателя отмечается зелёным' : 'Рост показателя отмечается зелёным'}`, pct, values[j]);
  });
}
