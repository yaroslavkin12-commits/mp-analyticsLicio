const { query } = require('../db');

// ─────────────────────────────────────────────────────────────────────────
// Лента заказов и самовыкупы.
//   order_feed   — отправления из вкладки Orders Google-таблицы (скрипт кладёт
//                  туда заказы за 2–3 дня, здесь они копятся без срока).
//   self_buyouts — отмеченные пользователем самовыкупы (отправление × SKU).
// Самовыкупы:
//   • убираются из заказов (шт и ₽) по дню заказа — «Аналитика продаж», РНП,
//     конструктор, «Реклама» (applyToAnalytics);
//   • в деньгах выручка и выкупы остаются, но себестоимость за эти штуки не
//     вычитается: штуки сопоставляются с продажами того же SKU в начислениях
//     Ozon начиная с дня заказа (по очереди), см. matchToSales.
// ─────────────────────────────────────────────────────────────────────────
let ready = null;
function ensure() {
  if (!ready) {
    ready = (async () => {
      await query(`CREATE TABLE IF NOT EXISTS order_feed (
        cabinet VARCHAR(32) NOT NULL, posting_number VARCHAR(64) NOT NULL, sku BIGINT NOT NULL DEFAULT 0,
        offer_id VARCHAR(128), name TEXT, price NUMERIC(14,2), qty INT DEFAULT 1, status VARCHAR(48), warehouse VARCHAR(160),
        created_at TIMESTAMPTZ, scheme VARCHAR(8), updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (cabinet, posting_number, sku))`);
      await query(`CREATE INDEX IF NOT EXISTS order_feed_cab_created ON order_feed (cabinet, created_at)`);
      await query(`CREATE TABLE IF NOT EXISTS self_buyouts (
        cabinet VARCHAR(32) NOT NULL, posting_number VARCHAR(64) NOT NULL, sku BIGINT NOT NULL DEFAULT 0,
        offer_id VARCHAR(128), qty INT DEFAULT 1, price NUMERIC(14,2), order_date DATE, marked_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (cabinet, posting_number, sku))`);
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}

const mskDate = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t + 3 * 3600e3).toISOString().slice(0, 10) : null; };
const num = v => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

// Строки вкладки Orders → order_feed. Пишем только новые и изменившиеся (память по ключу).
const SEEN = new Map(); // cabinet -> Map(key -> hash)
async function ingest(cabinet, rows) {
  await ensure();
  let mem = SEEN.get(cabinet);
  if (!mem) { mem = new Map(); SEEN.set(cabinet, mem); }
  const out = [];
  for (const r of rows) {
    if (r.cabinet !== cabinet || !r.posting_number) continue;
    const sku = Math.round(num(r.sku)) || 0;
    const key = `${r.posting_number}|${sku}`;
    const row = [cabinet, String(r.posting_number).slice(0, 64), sku, r.offer_id ? String(r.offer_id).slice(0, 128) : null, String(r.name || '').slice(0, 300),
      num(r.price) || null, Math.max(1, Math.round(num(r.quantity)) || 1), String(r.status || '').slice(0, 48), String(r.warehouse || '').slice(0, 160),
      r.created_at ? new Date(r.created_at).toISOString() : null, String(r.scheme || '').slice(0, 8)];
    const h = row.slice(3).join('|');
    if (mem.get(key) === h) continue;
    mem.set(key, h);
    out.push(row);
  }
  for (let i = 0; i < out.length; i += 500) {
    const part = out.slice(i, i + 500), params = [];
    const values = part.map(row => `(${row.map(v => { params.push(v); return `$${params.length}`; }).join(',')}, NOW())`);
    await query(`INSERT INTO order_feed (cabinet, posting_number, sku, offer_id, name, price, qty, status, warehouse, created_at, scheme, updated_at)
      VALUES ${values.join(',')}
      ON CONFLICT (cabinet, posting_number, sku) DO UPDATE SET offer_id = EXCLUDED.offer_id, name = EXCLUDED.name, price = EXCLUDED.price,
        qty = EXCLUDED.qty, status = EXCLUDED.status, warehouse = EXCLUDED.warehouse, created_at = COALESCE(EXCLUDED.created_at, order_feed.created_at),
        scheme = EXCLUDED.scheme, updated_at = NOW()`, params);
  }
  if (mem.size > 30000) mem.clear();
  return out.length;
}

// Цена самовыкупа — актуальная из ленты: отметить заказ могли, когда Ozon ещё не передал
// цену (в self_buyouts тогда пусто), — иначе выручка самовыкупа вычиталась бы как 0.
const PRICE = `COALESCE(NULLIF(f.price, 0), s.price, 0)`;
const JOIN = `LEFT JOIN order_feed f ON f.cabinet = s.cabinet AND f.posting_number = s.posting_number AND f.sku = s.sku`;

// Самовыкупы за даты заказа [from, to]: Map('sku|date' → { q, r }).
async function selfByDay(cabinet, from, to) {
  await ensure();
  // fbs — отправлений FBS/rFBS: за каждое Ozon берёт сервисный сбор за интеграцию с логистикой (20 ₽).
  const rows = await query(`SELECT s.sku, s.order_date::text d, SUM(s.qty)::int q, SUM(${PRICE} * s.qty) r,
      COUNT(DISTINCT s.posting_number) FILTER (WHERE f.scheme = 'fbs')::int fbs FROM self_buyouts s ${JOIN}
    WHERE s.cabinet = $1 AND s.order_date BETWEEN $2 AND $3 GROUP BY s.sku, s.order_date`, [cabinet, from, to]).catch(() => []);
  return new Map(rows.map(x => [`${x.sku}|${x.d}`, { q: num(x.q), r: num(x.r), fbs: num(x.fbs) }]));
}

// Убрать самовыкупы из строк product_analytics_daily (поля orders_item, revenue).
// rows: [{ sku, date, orders_item, revenue }]; одно уменьшение на (sku, день).
function applyToAnalytics(rows, map) {
  if (!map || !map.size) return;
  const left = new Map([...map.entries()].map(([k, v]) => [k, { ...v }]));
  for (const r of rows) {
    const k = `${r.sku}|${r.date}`, s = left.get(k);
    if (!s || (!s.q && !s.r)) continue;
    const dq = Math.min(num(r.orders_item), s.q), dr = Math.min(num(r.revenue), s.r);
    r.orders_item = num(r.orders_item) - dq; r.revenue = num(r.revenue) - dr;
    s.q -= dq; s.r -= dr;
  }
}

// Самовыкупы за период по SKU (для итогов прошлого периода): Map(sku → { q, r }).
async function selfBySku(cabinet, from, to) {
  await ensure();
  const rows = await query(`SELECT s.sku, SUM(s.qty)::int q, SUM(${PRICE} * s.qty) r FROM self_buyouts s ${JOIN}
    WHERE s.cabinet = $1 AND s.order_date BETWEEN $2 AND $3 GROUP BY s.sku`, [cabinet, from, to]).catch(() => []);
  return new Map(rows.map(x => [String(x.sku), { q: num(x.q), r: num(x.r) }]));
}

// Сопоставить самовыкупы с продажами в начислениях: штуки самовыкупа SKU гасят продажи
// этого SKU, начиная с дня заказа, по порядку. sales: [{ sku, d, q }] (q > 0 — продано за день).
// Возвращает Map('sku|d' → штук самовыкупа в продажах этого дня).
async function matchToSales(cabinet, sales, from, to) {
  await ensure();
  const sb = await query(`SELECT sku, order_date::text d, SUM(qty)::int q FROM self_buyouts
    WHERE cabinet = $1 AND order_date BETWEEN $2 AND $3 GROUP BY sku, order_date ORDER BY order_date`, [cabinet, from, to]).catch(() => []);
  const out = new Map();
  if (!sb.length) return out;
  const bySku = new Map();
  for (const s of sales) { if (!(s.q > 0)) continue; const a = bySku.get(String(s.sku)) || []; a.push({ d: s.d, q: s.q }); bySku.set(String(s.sku), a); }
  for (const a of bySku.values()) a.sort((x, y) => (x.d < y.d ? -1 : 1));
  for (const s of sb) {
    let need = num(s.q);
    for (const day of bySku.get(String(s.sku)) || []) {
      if (need <= 0) break;
      if (day.d < s.d || day.q <= 0) continue;
      const take = Math.min(need, day.q);
      day.q -= take; need -= take;
      const k = `${s.sku}|${day.d}`;
      out.set(k, (out.get(k) || 0) + take);
    }
  }
  return out;
}

module.exports = { ensure, ingest, selfByDay, selfBySku, applyToAnalytics, matchToSales, mskDate };
