// ─────────────────────────────────────────────────────────────────────────
// Изменения цены для журнала «Рекламы».
// Репрайсер держит цену КЛИЕНТА (с Ozon-картой): когда Ozon меняет скидку
// (СПП), он двигает цену реализации, а цена клиента остаётся ± та же. Поэтому:
//   • наше изменение = сдвиг цены клиента на ≥ 1,5% (и ≥ 30 ₽), который
//     держится (подтверждён следующей проверкой), и цена реализации сдвинулась
//     в ту же сторону — дрожание репрайсера (2 990 ↔ 2 983) и сдвиги СПП
//     (меняется одна из двух цен) не видны;
//   • изменения из «Журнала цен» (выгрузка репрайсера «было → стало») —
//     точные, они важнее найденных по сайту.
// Цены по дням: price_daily (последняя проверка дня) + история Соинвеста.
// ─────────────────────────────────────────────────────────────────────────
const dayjs = require('dayjs');
const { query } = require('../db');

let ready = null;
function ensurePriceDaily() {
  if (!ready) {
    ready = query(`CREATE TABLE IF NOT EXISTS price_daily (
      cabinet TEXT NOT NULL, offer_id TEXT NOT NULL, date DATE NOT NULL,
      seller NUMERIC(12,2), card NUMERIC(12,2), updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (cabinet, offer_id, date))`).catch(e => { ready = null; throw e; });
  }
  return ready;
}

// Последняя записанная пара цен по артикулу — чтобы не писать одно и то же.
const LAST = new Map();
const mskDay = () => dayjs().add(3, 'hour').toISOString().slice(0, 10);

// rows: [{ offer, seller, card }] — цены сейчас (card — цена клиента с Ozon-картой).
async function recordPrices(cabinet, rows) {
  try {
    await ensurePriceDaily();
    const d = mskDay();
    const vals = [];
    for (const r of rows) {
      const seller = Number(r.seller) || null, card = Number(r.card) || null;
      if (!r.offer || (!seller && !card)) continue;
      const k = `${cabinet}|${r.offer}`, prev = LAST.get(k);
      if (prev && prev.d === d && prev.s === seller && prev.c === card) continue;
      LAST.set(k, { d, s: seller, c: card });
      vals.push([cabinet, r.offer, d, seller, card]);
    }
    for (let i = 0; i < vals.length; i += 500) {
      const part = vals.slice(i, i + 500), params = [];
      const sql = part.map(v => `(${v.map(x => { params.push(x); return '$' + params.length; }).join(',')}, NOW())`).join(',');
      await query(`INSERT INTO price_daily (cabinet, offer_id, date, seller, card, updated_at) VALUES ${sql}
        ON CONFLICT (cabinet, offer_id, date) DO UPDATE SET seller = COALESCE(EXCLUDED.seller, price_daily.seller),
        card = COALESCE(EXCLUDED.card, price_daily.card), updated_at = NOW()`, params);
    }
    return vals.length;
  } catch (e) { console.warn('[priceDaily]', e.message); return 0; }
}

const fmt = v => Math.round(v).toLocaleString('ru-RU');
const pct = (a, b) => { const p = (b / a - 1) * 100; return `${p > 0 ? '+' : '−'}${Math.abs(p).toFixed(1).replace('.', ',')}%`; };

async function getJson(key) {
  const r = await query(`SELECT value FROM app_settings WHERE key = $1`, [key]).catch(() => []);
  try { return r[0] ? JSON.parse(r[0].value) : null; } catch (e) { return null; }
}

// События изменения цены клиента за [from, to].
async function priceEvents(cabinet, from, to) {
  const out = [];
  // 1) Журнал цен: выгрузки репрайсера «было → стало».
  const logged = new Map(); // offer -> [{date, dir}]
  const idx = (await getJson(`pricelog:${cabinet}:ozon:index`)) || [];
  for (const m of idx) {
    if (m.date < dayjs(from).subtract(3, 'day').format('YYYY-MM-DD') || m.date > to) continue;
    const s = await getJson(`pricelog:${cabinet}:ozon:snap:${m.id}`);
    if (!s || !s.old) continue;
    for (const [o, b] of Object.entries(s.items || {})) {
      const a = s.old[o];
      if (!a || !b || Math.abs(b - a) < 0.5) continue;
      const dir = b > a ? 1 : -1;
      if (!logged.has(o)) logged.set(o, []);
      logged.get(o).push({ date: s.date, dir });
      if (s.date < from) continue;
      out.push({ offerId: o, date: s.date, kind: dir > 0 ? 'price_up' : 'price_down', src: 'log',
        text: `Цена клиента ${fmt(a)} → ${fmt(b)} ₽ (${pct(a, b)}) — из журнала цен` });
    }
  }
  // 2) Цены по дням с сайта: price_daily + история Соинвеста (последняя запись дня).
  await ensurePriceDaily().catch(() => {});
  const since = dayjs(from).subtract(14, 'day').format('YYYY-MM-DD');
  const [daily, hist] = await Promise.all([
    query(`SELECT offer_id, date::text AS d, seller, card FROM price_daily WHERE cabinet = $1 AND date BETWEEN $2 AND $3`, [cabinet, since, to]).catch(() => []),
    query(`SELECT DISTINCT ON (offer_id, d) offer_id, d, seller, card FROM (
             SELECT offer_id, ((collected_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Moscow')::date::text AS d, collected_at,
                    marketing_seller_price AS seller, NULLIF(marketing_oa_price, 0) AS card
               FROM product_discount_history WHERE cabinet = $1 AND platform = 'ozon' AND collected_at >= $2::date - INTERVAL '1 day') t
            WHERE card IS NOT NULL ORDER BY offer_id, d, collected_at DESC`, [cabinet, since]).catch(() => []),
  ]);
  const series = new Map(); // offer -> Map(day -> {s, c})
  const put = (o, d, s, c, prefer) => {
    if (!c) return;
    if (!series.has(o)) series.set(o, new Map());
    const m = series.get(o);
    if (prefer || !m.has(d)) m.set(d, { s: Number(s) || null, c: Number(c) });
  };
  for (const r of hist) put(r.offer_id, r.d, r.seller, r.card, false);
  for (const r of daily) put(r.offer_id, r.d, r.seller, r.card, true);
  for (const [o, m] of series) {
    const days = [...m.keys()].sort();
    let lvl = null; // устойчивая цена клиента и цена реализации на тот момент
    for (let i = 0; i < days.length; i++) {
      const p = m.get(days[i]);
      if (!lvl) { lvl = { c: p.c, s: p.s }; continue; }
      const diff = p.c / lvl.c - 1;
      if (Math.abs(diff) < 0.015 || Math.abs(p.c - lvl.c) < 30) continue;
      // Подтверждение: следующая проверка держит новую цену (±1%); последняя точка — только если сдвиг ≥ 3%.
      const nx = i + 1 < days.length ? m.get(days[i + 1]) : null;
      const held = nx ? Math.abs(nx.c / p.c - 1) <= 0.01 : Math.abs(diff) >= 0.03;
      if (!held) continue;
      // Наше изменение двигает и цену реализации в ту же сторону (при той же СПП — на тот же %).
      // Цена клиента сдвинулась, а реализации нет (или в другую сторону) — это скидка Ozon,
      // репрайсер ещё не подтянул: не показываем, уровень не меняем.
      const sd = lvl.s && p.s ? p.s / lvl.s - 1 : null;
      if (sd === null || Math.sign(sd) !== Math.sign(diff) || Math.abs(sd) < Math.abs(diff) * 0.5) continue;
      const d = days[i], dir = diff > 0 ? 1 : -1;
      const dup = (logged.get(o) || []).some(x => x.dir === dir && Math.abs(dayjs(x.date).diff(d, 'day')) <= 3);
      if (!dup && d >= from && d <= to) {
        out.push({ offerId: o, date: d, kind: dir > 0 ? 'price_up' : 'price_down', src: 'site',
          text: `Цена клиента ${fmt(lvl.c)} → ${fmt(p.c)} ₽ (${pct(lvl.c, p.c)})${lvl.s && p.s ? ` · реализации ${fmt(lvl.s)} → ${fmt(p.s)} ₽` : ''} — по цене на сайте` });
      }
      lvl = { c: p.c, s: p.s };
    }
  }
  return out;
}

// Остаток: закончился (был > 0, стал 0) и снова появился (был 0) — по дневным снимкам остатков.
async function stockEvents(cabinet, from, to) {
  const since = dayjs(from).subtract(3, 'day').format('YYYY-MM-DD');
  const rows = await query(`SELECT offer_id, d, SUM(v)::int AS v FROM (
        SELECT offer_id, snapshot_date::text AS d, fbo_present + fbs_present AS v, collected_at,
               MAX(collected_at) OVER (PARTITION BY offer_id, snapshot_date) AS mx
          FROM ad_product_stocks WHERE cabinet = $1 AND platform = 'ozon' AND snapshot_date BETWEEN $2 AND $3) t
      WHERE collected_at = mx GROUP BY offer_id, d ORDER BY offer_id, d`, [cabinet, since, to]).catch(() => []);
  const out = [];
  let prevO = null, prevV = null;
  for (const r of rows) {
    if (r.offer_id !== prevO) { prevO = r.offer_id; prevV = r.v; continue; }
    const v = Number(r.v) || 0;
    if (r.d >= from) {
      if (prevV > 0 && v === 0) out.push({ offerId: r.offer_id, date: r.d, kind: 'stock_out', text: `Остаток закончился (было ${prevV} шт)` });
      else if (prevV === 0 && v > 0) out.push({ offerId: r.offer_id, date: r.d, kind: 'stock_in', text: `Остаток снова в наличии: 0 → ${v} шт` });
    }
    prevV = v;
  }
  return out;
}

module.exports = { recordPrices, priceEvents, ensurePriceDaily, stockEvents };
