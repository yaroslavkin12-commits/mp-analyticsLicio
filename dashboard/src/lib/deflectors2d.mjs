export const DEFAULT_2D = { multiple: 10, periodDays: 7, salesDays: 30, total: 140, fill: false };
const fail = message => { throw new Error(message); };
function integer(v, name, min, max, nullable = false) {
  if (nullable && (v === null || v === undefined || v === '')) return null;
  if (v === '' || v === null || v === undefined || typeof v === 'boolean' || !Number.isSafeInteger(Number(v)) || Number(v) < min || Number(v) > max) fail(`${name}: укажите целое число от ${min} до ${max}`);
  return Number(v);
}
export function validate2d(input) {
  const s = input?.settings || {};
  const settings = {
    multiple: integer(s.multiple, 'Кратность', 1, 10000), periodDays: integer(s.periodDays, 'Период подачи', 1, 365),
    salesDays: integer(s.salesDays, 'Период продаж', 1, 366), total: integer(s.total, 'Общее количество', 0, 1000000), fill: s.fill === true,
  };
  if (!Array.isArray(input.rows) || input.rows.length > 5000) fail('Допустимо не более 5000 артикулов');
  const seen = new Set();
  const rows = input.rows.map(r => {
    const offer = String(r.offer || '').trim();
    if (!offer || offer.length > 128 || seen.has(offer.toLowerCase())) fail('Артикулы должны быть заполнены и не повторяться');
    seen.add(offer.toLowerCase());
    return { offer, name: String(r.name || '').slice(0, 500), sales: integer(r.sales, 'Продажи', 0, 100000000, true),
      stock: integer(r.stock, 'Остаток', 0, 100000000, true), transit: integer(r.transit, 'В пути', 0, 100000000, true),
      manual: integer(r.manual, 'Подсорт вручную', 0, 1000000, true), enabled: r.enabled !== false, note: String(r.note || '').slice(0, 500) };
  });
  return { settings, rows };
}

// Каждая следующая партия — артикулу с наименьшим запасом в днях.
// Очередь нужна, чтобы большие лимиты не приводили к перебору всей таблицы.
function distribute(rows, settings, manual) {
  const { multiple, periodDays, total, fill } = settings, result = new Map(), heap = [];
  const less = (a, b) => a.cover < b.cover || a.cover === b.cover && a.row.offer < b.row.offer;
  function push(x) { heap.push(x); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (!less(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } }
  function pop() { const x = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; while (true) { let j = i, l = i * 2 + 1, r = l + 1; if (l < heap.length && less(heap[l], heap[j])) j = l; if (r < heap.length && less(heap[r], heap[j])) j = r; if (j === i) break; [heap[i], heap[j]] = [heap[j], heap[i]]; i = j; } } return x; }
  let reserved = 0;
  for (const row of rows) {
    const fixed = manual && row.manual !== null;
    const qty = row.enabled && fixed ? row.manual : 0;
    result.set(row.offer, qty); reserved += qty;
    if (!row.enabled || fixed || !(row.rate > 0) || row.available === null) continue;
    const cap = fill ? Infinity : Math.ceil(Math.max(0, row.need) / multiple - 1e-9) * multiple;
    if (cap > 0) push({ row, cap, qty: 0, cover: row.available / row.rate });
  }
  let batches = Math.floor(Math.max(0, total - reserved) / multiple);
  while (batches > 0 && heap.length) {
    const x = pop(); x.qty += multiple; batches--; result.set(x.row.offer, x.qty);
    if (x.qty < x.cap) { x.cover = (x.row.available + x.qty) / x.row.rate; push(x); }
  }
  return result;
}
export function calculate2d(input) {
  const draft = validate2d(input), { settings } = draft;
  const rows = draft.rows.map(r => {
    const rate = r.sales === null ? null : r.sales / settings.salesDays;
    const available = r.stock === null || r.transit === null ? null : r.stock + r.transit;
    return { ...r, rate, available, need: rate === null || available === null ? null : Math.max(0, rate * settings.periodDays - available), cover: rate > 0 && available !== null ? available / rate : null };
  });
  const recommendation = distribute(rows, settings, false), final = distribute(rows, settings, true);
  const issues = rows.filter(r => r.enabled && r.manual !== null && r.manual % settings.multiple !== 0).map(r => `${r.offer}: ручное количество должно быть кратно ${settings.multiple}`);
  const result = rows.map(r => ({ ...r, recommended: recommendation.get(r.offer), quantity: final.get(r.offer), after: r.rate > 0 && r.available !== null ? (r.available + final.get(r.offer)) / r.rate : null }));
  const total = result.reduce((sum, r) => sum + r.quantity, 0);
  return { settings, rows: result, total, left: Math.max(0, settings.total - total), over: Math.max(0, total - settings.total), issues };
}
