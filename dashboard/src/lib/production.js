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
  const P = 0.6 * H + 0.4 * (w4 / 28);
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
  const Y = Math.round(((T === null ? 0 : Math.max(0, 45 - T) * 20) + P * 300 + trendB + TOP_BONUS(row.top)) * 100) / 100;
  let U;
  if (P < 0.1 && ((Q !== null && Q < 0.8) || year < 20)) U = 'REVIEW SKU';
  else if (T === null) U = 'REVIEW SKU';
  else if (T < 28) U = (Q !== null && Q > 1.2) || P > 1 ? 'RAISE +5%' : 'RAISE +3%';
  else if (T <= 45) U = 'KEEP PRICE';
  else if (T > 60) U = (Q !== null && Q < 0.8) || P < 0.3 ? 'DROP -5%' : 'DROP -3%';
  else U = 'DROP -3%';
  return { year, w4, w8, stock, sew, H, P, Q, R, S, T, V, W, Y, U, ahead: w4 >= year / 12 };
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
  return { map: out, usedTasks, usedPcs };
}
