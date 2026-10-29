export const DEFAULT_2D = { multiple: 10, periodDays: 7, salesDays: 30, total: 140, fill: false };
const fail = message => { throw new Error(message); };
function integer(v, name, min, max, nullable = false) {
  if (nullable && (v === null || v === undefined || v === '')) return null;
  if (v === '' || v === null || v === undefined || typeof v === 'boolean' || !Number.isSafeInteger(Number(v)) || Number(v) < min || Number(v) > max) fail(`${name}: укажите целое число от ${min} до ${max}`);
  return Number(v);
}
export function validate2d(input) {
  const s = input?.settings || {};
  if (s.source !== undefined && !['ozon', 'manual'].includes(s.source)) fail('Неизвестный источник продаж');
  const settings = {
    multiple: integer(s.multiple, 'Кратность', 1, 10000), periodDays: integer(s.periodDays, 'Период подачи', 1, 365),
    salesDays: integer(s.salesDays, 'Период продаж', 1, 366), total: integer(s.total, 'Общее количество', 0, 1000000), fill: s.fill === true, source: s.source === 'ozon' ? 'ozon' : 'manual',
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
  let annual = null;
  if (input.annual) {
    const a = input.annual, items = Object.create(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(a.to || '') || !Number.isFinite(Date.parse(a.from)) || !Number.isFinite(Date.parse(a.to)) || new Date(a.from).toISOString().slice(0, 10) !== a.from || new Date(a.to).toISOString().slice(0, 10) !== a.to) fail('Укажите даты годовых продаж 1С');
    const days = Math.round((Date.parse(a.to) - Date.parse(a.from)) / 86400000) + 1;
    if (days < 330 || days > 370) fail('Файл годовых продаж должен охватывать от 330 до 370 дней');
    if (!a.items || typeof a.items !== 'object' || Array.isArray(a.items) || Object.keys(a.items).length > 20000) fail('Некорректный список годовых продаж');
    for (const [key, value] of Object.entries(a.items)) { const offer = key.trim().toLowerCase(); if (!offer || offer.length > 128 || Object.hasOwn(items, offer)) fail('Артикулы 1С не должны повторяться'); items[offer] = integer(value, 'Продажи 1С', 0, 100000000); }
    annual = { from: a.from, to: a.to, days, file: String(a.file || '').slice(0, 255), uploadedAt: String(a.uploadedAt || '').slice(0, 40), items };
  }
  return { settings, rows, ...(annual ? { annual } : {}) };
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
export function calculate2d(input, demand = null) {
  const draft = validate2d(input), { settings } = draft;
  const rows = draft.rows.map(r => {
    const ozon = demand?.articles?.find(a => a.offer.toLowerCase() === r.offer.toLowerCase());
    const rate = settings.source === 'ozon' ? (ozon?.rate ?? null) : r.sales === null ? null : r.sales / settings.salesDays;
    const history = Object.fromEntries(PERIODS_2D.map(d => ['q' + d, ozon?.periods?.['d' + d]?.quantity ?? null]));
    const annual1c = draft.annual ? (Object.hasOwn(draft.annual.items, r.offer.toLowerCase()) ? draft.annual.items[r.offer.toLowerCase()] : null) : null;
    const available = r.stock === null || r.transit === null ? null : r.stock + r.transit;
    return { ...r, ...history, annual1c, annualRate1c: annual1c === null ? null : annual1c / draft.annual.days, trend7: ozon?.trend7 ?? null, trend30: ozon?.trend30 ?? null, lastYear30: ozon?.periods?.lastYear30?.quantity ?? null, ratePeriods: ozon?.ratePeriods || [], rateWindow: settings.source === 'ozon' ? (ozon?.ratePeriods?.join(' / ') || 'нет полных периодов') : `ручные ${settings.salesDays} дней`, rate, available, need: rate === null || available === null ? null : Math.max(0, rate * settings.periodDays - available), cover: rate > 0 && available !== null ? available / rate : null };
  });
  const recommendation = distribute(rows, settings, false), final = distribute(rows, settings, true);
  const issues = rows.filter(r => r.enabled && r.manual !== null && r.manual % settings.multiple !== 0).map(r => `${r.offer}: ручное количество должно быть кратно ${settings.multiple}`);
  const result = rows.map(r => ({ ...r, recommended: recommendation.get(r.offer), quantity: final.get(r.offer), after: r.rate > 0 && r.available !== null ? (r.available + final.get(r.offer)) / r.rate : null }));
  const total = result.reduce((sum, r) => sum + r.quantity, 0);
  return { settings, rows: result, total, left: Math.max(0, settings.total - total), over: Math.max(0, total - settings.total), issues };
}


export const PERIODS_2D = [7, 14, 30, 60, 90, 365];
const iso = t => new Date(t).toISOString().slice(0, 10);
const span = (end, days) => Array.from({ length: days }, (_, i) => iso(Date.parse(end) - (days - 1 - i) * 86400000));
// Заказы Ozon без самовыкупов; неполный период не выдаётся за нулевые продажи.
// Адаптеры других площадок впоследствии должны отдавать такие же дни/артикулы.
export function buildOzonDemand({ to, articles, shops, sales, coverage }) {
  const present = new Set(coverage.map(r => `${r.cabinet}|${r.date}`));
  const dates = new Map(PERIODS_2D.map(d => ['d' + d, span(to, d)]));
  dates.set('prev7', span(iso(Date.parse(to) - 7 * 86400000), 7));
  dates.set('prev30', span(iso(Date.parse(to) - 30 * 86400000), 30));
  // День в день прошлого календарного года, включая переход через високосный год.
  const last = new Date(to + 'T00:00:00Z'); const month = last.getUTCMonth(); last.setUTCFullYear(last.getUTCFullYear() - 1); if (last.getUTCMonth() !== month) last.setUTCDate(0);
  dates.set('lastYear30', span(iso(last), 30));
  const ranges = Object.fromEntries([...dates].map(([key, ds]) => {
    const byShop = shops.map(s => ({ ...s, days: ds.filter(d => present.has(`${s.id}|${d}`)).length, expected: ds.length }));
    return [key, { from: ds[0], to: ds.at(-1), days: ds.length, complete: byShop.every(s => s.days === s.expected), shops: byShop }];
  }));
  const daily = new Map();
  for (const r of sales) { if (!r.offer_id || !shops.some(s => s.id === r.cabinet)) continue; const key = `${r.offer_id.toLowerCase()}|${r.date}`; daily.set(key, (daily.get(key) || 0) + Math.max(0, Number(r.orders_item) || 0)); }
  const trend = (current, prev) => current === null || prev === null || prev === 0 ? null : (current / prev - 1) * 100;
  return { to, platform: 'ozon', shops, ranges, articles: articles.map(a => {
    const periods = Object.fromEntries([...dates].map(([key, ds]) => [key, { quantity: ranges[key].complete ? ds.reduce((q, date) => q + (daily.get(`${a.offer.toLowerCase()}|${date}`) || 0), 0) : null }]));
    const weighted = [[7, 0.5], [14, 0.3], [30, 0.2]].filter(([days]) => periods['d' + days].quantity !== null);
    const weight = weighted.reduce((s, [, w]) => s + w, 0);
    const rate = weight ? weighted.reduce((s, [days, w]) => s + periods['d' + days].quantity / days * w, 0) / weight : null;
    return { ...a, periods, rate, ratePeriods: weighted.map(([days]) => days), trend7: trend(periods.d7.quantity, periods.prev7.quantity), trend30: trend(periods.d30.quantity, periods.prev30.quantity) };
  }) };
}

export function parseAnnual2d(rows, offerCol, qtyCol, startRow = 0) {
  const items = Object.create(null), rejected = [];
  for (let i = startRow; i < rows.length; i++) {
    const r = rows[i], offer = String(r[offerCol] ?? '').trim(), raw = r[qtyCol];
    if (!offer && (raw === '' || raw == null)) continue;
    if (!offer || /^(итого|всего|артикул)(\s|$)/i.test(offer)) { if (offer) continue; rejected.push(i + 1); continue; }
    const quantity = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/[\s\u00a0]/g, '').replace(',', '.'));
    if (raw == null || String(raw).trim() === '' || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > 100000000 || offer.length > 128) { rejected.push(i + 1); continue; }
    const key = offer.toLowerCase(); items[key] = (items[key] || 0) + quantity;
    if (items[key] > 100000000) fail('Слишком большое количество по артикулу ' + offer);
  }
  return { items, rejected };
}
