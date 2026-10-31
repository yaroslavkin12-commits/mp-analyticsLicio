// Цвет сравнения, без изменения самих значений. Отсутствие данных не равно нулю.
export function resultTint(value, previous, good = 'up') {
  if (!Number.isFinite(value) || !Number.isFinite(previous) || good === 'neutral') return undefined;
  const delta = value - previous;
  if (Math.abs(delta) <= Math.abs(previous)*.05 || delta === 0) return 'var(--a-warn-soft)';
  return (good === 'down' ? delta < 0 : delta > 0) ? 'var(--a-good-soft)' : 'var(--a-bad-soft)';
}
