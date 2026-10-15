// ─────────────────────────────────────────────────────────────────────────
// Потребность на производство (чехлы на сиденья) — перенос логики файла
// sales_system_v55 (лист DASHBOARD) один в один:
//   H  продажи/день база   = год / 365
//   P  продажи/день гибрид = 0,6·H + 0,4·(4 нед / 28)
//   Q  тренд               = (4 нед / 28) / H;  R = Q в пределах 0,8…1,2
//   S  целевой запас       = ⌈P · (цикл + буфер) · R⌉
//   T  покрытие, дней      = (остаток + в пути · k) / P,  k = 0,5
//   V  решение             = T<28 ORDER · <35 PLAN · ≤45 HOLD · иначе NO ORDER
//   W  базовый заказ       = NO ORDER → 0, иначе ⌈max(0, S − остаток − в пути·k)⌉ до партии
//   Y  приоритет           = max(0,45−T)·20 + P·300 + тренд(+120/−40/+40) + TOP-бонус
//   U  сигнал цены         = как в файле (RAISE/KEEP/DROP/REVIEW)
// Заказ по цеху: артикулы с W>0 по убыванию приоритета, пока не наберётся
// лимит — в заданиях (1 задание = 6 шт экокожи или 10 шт жаккарда) или в штуках.
// ─────────────────────────────────────────────────────────────────────────

export const SHOPS = ['Гурьевская', 'Ельцовка', 'Искитим'];
export const MATERIALS = ['экокожа', 'жаккард'];
export const TOPS = ['TOP 10', 'TOP 20', 'TOP 50', 'TOP 100', 'ТОП по РЫНКУ', 'НОВИНКА', 'ХВОСТ'];
export const DEFAULT_SETTINGS = {
  capacity: { 'Ельцовка': 160, 'Гурьевская': 300, 'Искитим': 280 }, // шт в неделю
  transitK: 0.5,      // «в пути» учитывается на 50%
  taskSize: { 'экокожа': 6, 'жаккард': 10 },
  orderDays: { 1: ['Гурьевская'], 4: ['Ельцовка', 'Искитим'] }, // пн — Гурьевская, чт — Ельцовка и Искитим
};
const TOP_BONUS = t => (t === 'TOP 10' ? 1000 : t === 'TOP 20' ? 700 : t === 'TOP 50' ? 400 : t === 'TOP 100' ? 200 : /РЫНК/i.test(t || '') ? 300 : 0);

export const matOf = (m, name) => {
  const s = String(m || name || '').toLowerCase();
  return /кож/.test(s) ? 'экокожа' : /жак/.test(s) ? 'жаккард' : (m || '');
};
export const taskSizeOf = (row, settings = DEFAULT_SETTINGS) => settings.taskSize[matOf(row.mat, row.n)] || 10;

// row: { o, n, shop, mat, cycle, buffer, batch, top }, data: { year, w4, w8, stock, sew } (артикул → шт)
export function calcRow(row, data, settings = DEFAULT_SETTINGS) {
  const k = settings.transitK ?? 0.5;
  // Новинкам продажи за год задаются вручную (в файле — 365, т. е. 1 шт в день).
  const year = row.yearOv !== undefined && row.yearOv !== null && row.yearOv !== '' ? Number(row.yearOv) || 0 : Number(data.year?.[row.o]) || 0;
  const w4 = Number(data.w4?.[row.o]) || 0;
  const w8 = Number(data.w8?.[row.o]) || 0;
  const stock = Number(data.stock?.[row.o]) || 0;
  const sew = Number(data.sew?.[row.o]) || 0;
  const cycle = Number(row.cycle) || 21, buffer = Number(row.buffer) || 21, batch = Number(row.batch) || 10;
  const H = year / 365;
  // «Под рекламу» (focus): ждём рост продаж — прогноз в день × коэффициент
  // (по умолчанию 1,5), но не меньше вписанного минимума; приоритет выше.
  const fK = row.focus ? (Number(row.focusK) > 0 ? Number(row.focusK) : 1.5) : 1;
  const base = 0.6 * H + 0.4 * (w4 / 28);
  const P = row.focus ? Math.max(base * fK, Number(row.focusMin) || 0) : base;
  const Q = H > 0 ? (w4 / 28) / H : null;
  const R = Q === null ? 1 : Q > 1.2 ? 1.2 : Q < 0.8 ? 0.8 : 1;
  const S = Math.ceil(P * (cycle + buffer) * R - 1e-9);
  const T = P > 0 ? (stock + sew * k) / P : null;
  // В Excel деление на 0 даёт ошибку → покрытие пустое; сравнения "" < 28 ложны → NO ORDER.
  const V = T === null ? 'NO ORDER' : T < 28 ? 'ORDER' : T < 35 ? 'PLAN' : T <= 45 ? 'HOLD' : 'NO ORDER';
  const need = Math.max(0, S - stock - sew * k);
  const W = V === 'NO ORDER' ? 0 : need > 0 ? Math.ceil(need / batch - 1e-9) * batch : 0;
  // Как в Excel: нет продаж за год (тренд не посчитать) — бонус как за рост; нет покрытия — 0.
  const trendB = Q === null ? 120 : Q > 1.2 ? 120 : Q < 0.8 ? -40 : 40;
  const Y = Math.round(((T === null ? 0 : Math.max(0, 45 - T) * 20) + P * 300 + trendB + TOP_BONUS(row.top) + (row.focus ? 800 : 0)) * 100) / 100;
  let U;
  if (P < 0.1 && ((Q !== null && Q < 0.8) || year < 20)) U = 'REVIEW SKU';
  else if (T === null) U = 'REVIEW SKU';
  else if (T < 28) U = (Q !== null && Q > 1.2) || P > 1 ? 'RAISE +5%' : 'RAISE +3%';
  else if (T <= 45) U = 'KEEP PRICE';
  else if (T > 60) U = (Q !== null && Q < 0.8) || P < 0.3 ? 'DROP -5%' : 'DROP -3%';
  else U = 'DROP -3%';
  return { year, w4, w8, stock, sew, H, P, base, Q, R, S, T, V, W, Y, U, ahead: w4 >= year / 12 };
}

// Распределение по цеху. limit: { tasks } или { pcs } или null (без лимита).
// Возвращает Map(артикул → { qty, tasks }) и итоги.
export function allocate(rows, limit, settings = DEFAULT_SETTINGS) {
  const out = new Map();
  // «выводим» и артикулы без цеха в заказ не идут.
  const cand = rows.filter(r => r.c.W > 0 && SHOPS.includes(r.shop)).sort((a, b) => b.c.Y - a.c.Y || b.c.W - a.c.W);
  let usedTasks = 0, usedPcs = 0;
  for (const r of cand) {
    const ts = taskSizeOf(r, settings);
    let qty = r.c.W;
    if (limit && limit.tasks !== undefined && limit.tasks !== null && limit.tasks !== '') {
      const left = Number(limit.tasks) - usedTasks;
      if (left <= 0) break;
      const wantT = Math.ceil(qty / ts - 1e-9);
      const t = Math.min(wantT, left);
      qty = Math.min(qty, t * ts);
      if (t === wantT) qty = r.c.W; // целиком вошёл
    } else if (limit && limit.pcs) {
      const left = Number(limit.pcs) - usedPcs;
      if (left <= 0) break;
      qty = Math.min(qty, left);
    }
    if (qty <= 0) continue;
    const tasks = qty / ts;
    usedTasks += Math.ceil(tasks - 1e-9); usedPcs += qty;
    out.set(r.o, { qty, tasks });
  }
  // Не вошло: потребность, которая не уместилась в лимит (целиком или частично).
  const left = [];
  for (const r of cand) {
    const got = out.get(r.o)?.qty || 0;
    if (got < r.c.W) left.push({ r, qty: r.c.W - got, tasks: Math.ceil((r.c.W - got) / taskSizeOf(r, settings) - 1e-9) });
  }
  // Добор до лимита заданий, если потребности меньше: по одному заданию тем,
  // у кого после заказа меньше всего дней запаса (не дальше 90 дней).
  const added = new Map();
  if (limit && limit.fill && limit.tasks && usedTasks < Number(limit.tasks)) {
    const pool = rows.filter(r => SHOPS.includes(r.shop) && r.c.P > 0 && r.c.U !== 'REVIEW SKU');
    const k = settings.transitK ?? 0.5;
    const cov = r => (r.c.stock + r.c.sew * k + (out.get(r.o)?.qty || 0)) / r.c.P;
    for (let guard = 0; guard < 1000 && usedTasks < Number(limit.tasks); guard++) {
      let best = null, bc = Infinity;
      for (const r of pool) { const c = cov(r); if (c < 90 && (c < bc || (c === bc && best && r.c.Y > best.c.Y))) { best = r; bc = c; } }
      if (!best) break;
      const ts = taskSizeOf(best, settings);
      const cur = out.get(best.o) || { qty: 0, tasks: 0 };
      out.set(best.o, { qty: cur.qty + ts, tasks: (cur.qty + ts) / ts, fill: (cur.fill || 0) + ts });
      added.set(best.o, (added.get(best.o) || 0) + ts);
      usedTasks += 1; usedPcs += ts;
    }
  }
  return { map: out, usedTasks, usedPcs, left, added };
}

// ── Журнал заявок ─────────────────────────────────────────────────────────
// По каждому артикулу — открытые заявки (поданные и не закрытые) и сверка с
// последним файлом «Пошив» из 1С. В пошиве нет дат и цехов — это просто всё,
// что сейчас в работе, поэтому сравниваем с пошивом на момент первой открытой
// заявки (он сохраняется в заявке):
//   рост пошива ≥ 80% заказанного — «в работе»; рост меньше — «частично»;
//   роста нет, а файл свежее заявки и прошло ≥ 3 дней — «не взяли в работу?»;
//   файл пошива старше заявки — «ждём свежий пошив».
// В расчёт потребности журнал НЕ подмешивается — только подсказка.
export const J_STATUS = {
  miss: ['не взяли в работу?', 'dn'],
  part: ['взяли частично', 'warn'],
  work: ['в работе', 'up'],
  wait: ['ждём свежий пошив', ''],
  fresh: ['подана недавно', ''],
  unk: ['в пошиве есть, сверить', ''],
};
export function buildJournal(orders, closed, data, uploads, now = new Date()) {
  const sewAt = uploads?.sew?.at ? new Date(uploads.sew.at).getTime() : 0;
  const stockAt = uploads?.stock?.at ? new Date(uploads.stock.at).getTime() : 0;
  const by = new Map();
  for (const ord of orders || []) {
    const at = new Date(ord.savedAt || ord.date).getTime();
    if (now - at > 70 * 864e5) continue; // старше 10 недель — не показываем
    for (const it of ord.items || []) {
      const [o, qty, tasks, sew0, stock0, fill] = it;
      const cl = closed?.[o] ? new Date(closed[o]).getTime() : 0;
      let v = by.get(o);
      if (!v) { v = { o, lines: [], closedLines: [], closedAt: cl || null }; by.set(o, v); }
      const line = { id: ord.id, date: ord.date, at, shop: ord.shop, qty: Number(qty) || 0, tasks, sew0: sew0 ?? null, stock0: stock0 ?? null, fill: Number(fill) || 0 };
      (at <= cl ? v.closedLines : v.lines).push(line);
    }
  }
  const out = [];
  for (const v of by.values()) {
    const lines = v.lines.sort((a, b) => a.at - b.at);
    const all = lines.length ? lines : v.closedLines.sort((a, b) => a.at - b.at);
    const first = all[0], last = all[all.length - 1];
    const qty = lines.reduce((s, l) => s + l.qty, 0);
    const sewNow = Number(data?.sew?.[v.o]) || 0, stockNow = Number(data?.stock?.[v.o]) || 0;
    const sew0 = first.sew0, stock0 = first.stock0;
    const inc = sewNow - (sew0 ?? 0);
    const days = Math.floor((now - first.at) / 864e5);
    let st = null;
    if (lines.length) {
      if (sewAt <= first.at) st = days < 3 ? 'fresh' : 'wait';
      else if (sew0 === null && sewNow > 0) st = 'unk'; // заявка до журнала: с чем сравнивать — неизвестно
      else if (inc >= qty * 0.8) st = 'work';
      else if (inc > 0) st = 'part';
      else st = days >= 3 ? 'miss' : 'fresh';
    }
    out.push({ o: v.o, shop: last.shop, lines, closedLines: v.closedLines, closed: !lines.length, closedAt: v.closedAt, qty, fill: lines.reduce((s, l) => s + l.fill, 0),
      sew0, stock0, sewNow, stockNow, stockFresh: stockAt > first.at, inc, days, st, first, last });
  }
  return out;
}
